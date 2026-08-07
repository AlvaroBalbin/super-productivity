import { describe, it, expect, beforeAll, vi } from 'vitest';
import type {
  IssueProviderPluginDefinition,
  PluginHttp,
} from '@super-productivity/plugin-api';

let definition: IssueProviderPluginDefinition;

beforeAll(async () => {
  (globalThis as unknown as { PluginAPI: unknown }).PluginAPI = {
    registerIssueProvider: vi.fn((def: IssueProviderPluginDefinition) => {
      definition = def;
    }),
    translate: (key: string) => key,
  };
  await import('./plugin');
});

// Capture the WIQL query getNewIssuesForBacklog sends to the wiql endpoint.
// Returning an empty workItems list short-circuits the work-item detail fetch.
const captureBacklogQuery = async (config: Record<string, unknown>): Promise<string> => {
  let captured = '';
  const http = {
    post: vi.fn(async (_url: string, body: { query: string }) => {
      captured = body.query;
      return { workItems: [] };
    }),
    get: vi.fn(),
  } as unknown as PluginHttp;
  await definition.getNewIssuesForBacklog!(config, http);
  return captured;
};

describe('Azure DevOps Plugin - getNewIssuesForBacklog', () => {
  it('defaults to the assigned-to-me scope with the done-state exclusion', async () => {
    const query = await captureBacklogQuery({ project: 'MyProject' });
    expect(query).toContain(`[System.TeamProject] = 'MyProject'`);
    expect(query).toContain(`[System.State] <> 'Closed'`);
    expect(query).toContain(`[System.State] <> 'Done'`);
    expect(query).toContain(`[System.State] <> 'Removed'`);
    expect(query).toContain(`[System.AssignedTo] = @Me`);
  });

  it('omits the @Me clause when scope is "all"', async () => {
    const query = await captureBacklogQuery({ project: 'MyProject', scope: 'all' });
    expect(query).not.toContain('@Me');
    expect(query).toContain(`[System.TeamProject] = 'MyProject'`);
  });

  it('uses CreatedBy when scope is "created-by-me"', async () => {
    const query = await captureBacklogQuery({
      project: 'MyProject',
      scope: 'created-by-me',
    });
    expect(query).toContain(`[System.CreatedBy] = @Me`);
    expect(query).not.toContain(`[System.AssignedTo] = @Me`);
  });

  it('escapes single quotes in the project name', async () => {
    const query = await captureBacklogQuery({ project: "O'Brien" });
    expect(query).toContain(`[System.TeamProject] = 'O''Brien'`);
  });

  it('uses a custom WIQL query verbatim, overriding scope and project', async () => {
    const custom =
      "Select [System.Id] From WorkItems Where [System.IterationPath] = 'P\\Sprint 1'";
    const query = await captureBacklogQuery({
      project: 'MyProject',
      scope: 'all',
      autoImportWiql: custom,
    });
    expect(query).toBe(custom);
  });

  it('falls back to the default query when the custom WIQL is blank', async () => {
    const query = await captureBacklogQuery({
      project: 'MyProject',
      autoImportWiql: '   ',
    });
    expect(query).toContain(`[System.TeamProject] = 'MyProject'`);
    expect(query).toContain(`[System.AssignedTo] = @Me`);
  });
});

describe('Azure DevOps Plugin - work item detail fetch', () => {
  it('fetches details via workitemsbatch with errorPolicy Omit, so a process template missing a requested field (e.g. Scrum has no DueDate) does not fail the whole request', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const http = {
      post: vi.fn(async (url: string, body: unknown) => {
        calls.push({ url, body });
        if (url.includes('/wiql')) {
          return { workItems: [{ id: 42 }] };
        }
        // errorPolicy 'Omit' just leaves the field off the work item instead
        // of the request failing with TF51535.
        return {
          value: [
            {
              id: 42,
              fields: {
                'System.Id': 42,
                'System.Title': 'Do the thing',
                'System.WorkItemType': 'Product Backlog Item',
                'System.State': 'New',
              },
            },
          ],
        };
      }),
      get: vi.fn(),
    } as unknown as PluginHttp;

    const results = await definition.getNewIssuesForBacklog!(
      { project: 'MyProject' },
      http,
    );

    expect(results).toHaveLength(1);
    expect(results[0].due).toBe('');
    const batchCall = calls.find((c) => c.url.includes('workitemsbatch'));
    expect(batchCall).toBeDefined();
    expect(batchCall!.body).toMatchObject({ ids: [42], errorPolicy: 'Omit' });
    expect(http.get).not.toHaveBeenCalled();
  });
});
