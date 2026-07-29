/**
 * Contract for the `reminder_notification_labels` KeyValStore blob consumed by the
 * native Android reminder notifications. The native reader is
 * `android/app/src/main/java/com/superproductivity/superproductivity/service/ReminderNotificationLabels.kt`
 * — keep both ends in sync.
 *
 * Those notifications are built natively, often from a process the WebView never
 * started (alarm receiver after a reboot, background sync worker), so the labels
 * cannot be passed along with a single reminder. Angular pushes them whenever the
 * UI language changes instead; the native side falls back to English for anything
 * missing.
 */
export const ANDROID_REMINDER_LABELS_KEY = 'reminder_notification_labels';

export interface AndroidReminderLabels {
  taskReminder: string;
  dueDateReminder: string;
  done: string;
  snooze10m: string;
  snooze1h: string;
  summary: string;
}
