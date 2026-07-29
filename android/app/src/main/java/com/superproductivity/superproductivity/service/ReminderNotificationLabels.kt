package com.superproductivity.superproductivity.service

import android.content.Context
import android.util.Log
import com.superproductivity.superproductivity.App
import org.json.JSONObject

/**
 * The user-facing strings of a reminder notification, in the language the user
 * picked inside the app.
 */
data class ReminderLabels(
    val taskReminder: String,
    val dueDateReminder: String,
    val done: String,
    val snooze10m: String,
    val snooze1h: String,
    val summary: String
)

/**
 * Native end of the `reminder_notification_labels` KeyValStore contract. The writer is
 * Angular's AndroidEffects; the blob shape is defined by AndroidReminderLabels in
 * src/app/features/android/android-reminder-labels.model.ts — keep both ends in sync.
 *
 * The labels are read here rather than passed with each reminder because notifications
 * are also built without a WebView around (alarm receiver after a reboot, background
 * sync worker). Anything the writer has not pushed yet falls back to English.
 */
object ReminderNotificationLabels {
    const val KEYVAL_KEY = "reminder_notification_labels"
    private const val TAG = "ReminderNotifLabels"

    private val DEFAULTS = ReminderLabels(
        taskReminder = "Task reminder",
        dueDateReminder = "Due date reminder",
        done = "Done",
        snooze10m = "Snooze 10m",
        snooze1h = "Snooze 1h",
        summary = "Task reminders"
    )

    fun parse(json: String): ReminderLabels {
        val root = JSONObject(json)
        return ReminderLabels(
            taskReminder = root.label("taskReminder", DEFAULTS.taskReminder),
            dueDateReminder = root.label("dueDateReminder", DEFAULTS.dueDateReminder),
            done = root.label("done", DEFAULTS.done),
            snooze10m = root.label("snooze10m", DEFAULTS.snooze10m),
            snooze1h = root.label("snooze1h", DEFAULTS.snooze1h),
            summary = root.label("summary", DEFAULTS.summary)
        )
    }

    fun load(context: Context): ReminderLabels {
        return try {
            parse((context.applicationContext as App).keyValStore.get(KEYVAL_KEY, "{}"))
        } catch (e: Exception) {
            // An unreadable blob must never cost the user their reminder
            Log.e(TAG, "Failed to read reminder notification labels", e)
            DEFAULTS
        }
    }

    // isNull guard: optString maps JSON null to the literal string "null"
    private fun JSONObject.label(key: String, fallback: String): String =
        if (isNull(key)) fallback else optString(key, fallback).ifEmpty { fallback }
}
