import { CaldavCfg } from './caldav.model';
export { CALDAV_ISSUE_CONTENT_CONFIG } from './caldav-issue-content.const';
export { CALDAV_CONFIG_FORM_SECTION, CALDAV_CONFIG_FORM } from './caldav-cfg-form.const';

export const DEFAULT_CALDAV_CFG: CaldavCfg = {
  isEnabled: false,
  caldavUrl: null,
  resourceName: null,
  username: null,
  password: null,
  categoryFilter: null,
  // A CalDAV resource is a single, user-chosen calendar rather than a
  // searchable tracker, so tasks are expected to sync into the backlog
  // automatically once a default project is set (mirrors Plainspace).
  isAutoAddToBacklog: true,
  twoWaySync: {
    isDone: 'pullOnly',
    title: 'pullOnly',
    notes: 'off',
  },
};

export const CALDAV_POLL_INTERVAL = 10 * 60 * 1000;
export const CALDAV_INITIAL_POLL_DELAY = 8 * 1000;
