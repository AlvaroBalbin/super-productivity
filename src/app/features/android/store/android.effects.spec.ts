import { TestBed } from '@angular/core/testing';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { buildReminderLabels, buildTaskTitle } from './android.effects';
import EN_TRANSLATIONS from '../../../../assets/i18n/en.json';

/**
 * #9344: the reminder notification is rendered natively, so its strings never went
 * through the translations and stayed English whatever language was picked.
 */
describe('buildReminderLabels', () => {
  let translateService: TranslateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
    });
    translateService = TestBed.inject(TranslateService);
    translateService.setTranslation('en', EN_TRANSLATIONS);
    translateService.use('en');
  });

  it('builds the labels the native side falls back to for English', () => {
    expect(buildReminderLabels(translateService)).toEqual({
      taskReminder: 'Task reminder',
      dueDateReminder: 'Due date reminder',
      done: 'Done',
      snooze10m: 'Snooze 10m',
      snooze1h: 'Snooze 1h',
      summary: 'Task reminders',
    });
  });

  it('builds them in the selected language', () => {
    translateService.setTranslation('de', {
      NOTIFICATION: {
        TASK_REMINDER: 'Aufgabenerinnerung',
        DUE_DATE_REMINDER: 'Erinnerung an Fälligkeitsdatum',
        DONE: 'Erledigt',
        SNOOZE_10M: '10 Min. schlummern',
        SNOOZE_1H: '1 Std. schlummern',
        TASK_REMINDERS: 'Aufgabenerinnerungen',
      },
    });
    translateService.use('de');

    expect(buildReminderLabels(translateService)).toEqual({
      taskReminder: 'Aufgabenerinnerung',
      dueDateReminder: 'Erinnerung an Fälligkeitsdatum',
      done: 'Erledigt',
      snooze10m: '10 Min. schlummern',
      snooze1h: '1 Std. schlummern',
      summary: 'Aufgabenerinnerungen',
    });
  });
});

describe('android share helpers', () => {
  describe('buildTaskTitle', () => {
    it('prefers the subject (page title from browsers) over everything else', () => {
      expect(
        buildTaskTitle({
          subject: 'Great Article',
          title: 'Some Title',
          type: 'LINK',
          path: 'https://example.com/post',
        }),
      ).toBe('Great Article');
    });

    it('falls back to the explicit title when there is no subject', () => {
      expect(
        buildTaskTitle({
          subject: '',
          title: 'Some Title',
          type: 'LINK',
          path: 'https://example.com/post',
        }),
      ).toBe('Some Title');
    });

    // Regression: a share without subject/title must derive a readable title
    // from the link, not the generic "Shared Content" placeholder.
    it('derives a readable title from the URL for links without subject/title', () => {
      expect(
        buildTaskTitle({
          subject: '',
          title: '',
          type: 'LINK',
          path: 'https://www.example.com/some-cool-article',
        }),
      ).toBe('example.com: some cool article');
    });

    it('uses the first line of content for notes without subject/title', () => {
      expect(
        buildTaskTitle({
          subject: '',
          title: '',
          type: 'NOTE',
          path: 'Buy milk\nand bread',
        }),
      ).toBe('Buy milk');
    });

    it('falls back to "Shared note" for empty note content', () => {
      expect(buildTaskTitle({ subject: '', title: '', type: 'NOTE', path: '' })).toBe(
        'Shared note',
      );
    });

    it('tolerates missing fields', () => {
      expect(buildTaskTitle({})).toBe('Shared note');
    });

    it('truncates very long titles to 150 chars', () => {
      const result = buildTaskTitle({
        subject: 'x'.repeat(300),
        type: 'NOTE',
        path: 'p',
      });
      expect(result.length).toBe(150);
      expect(result.endsWith('...')).toBeTrue();
    });
  });
});
