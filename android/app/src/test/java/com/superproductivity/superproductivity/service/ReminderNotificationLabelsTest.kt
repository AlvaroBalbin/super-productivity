package com.superproductivity.superproductivity.service

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Locks the native end of the `reminder_notification_labels` contract. The writer-side
 * shape is locked by android.effects.spec.ts — if one changes, the other must too.
 */
class ReminderNotificationLabelsTest {

    private val blob =
        """
        {
          "taskReminder": "Aufgabenerinnerung",
          "dueDateReminder": "Erinnerung an Fälligkeitsdatum",
          "done": "Erledigt",
          "snooze10m": "10 Min. schlummern",
          "snooze1h": "1 Std. schlummern",
          "summary": "Aufgabenerinnerungen"
        }
        """.trimIndent()

    @Test
    fun parsesTranslatedLabels() {
        val labels = ReminderNotificationLabels.parse(blob)
        assertEquals("Aufgabenerinnerung", labels.taskReminder)
        assertEquals("Erinnerung an Fälligkeitsdatum", labels.dueDateReminder)
        assertEquals("Erledigt", labels.done)
        assertEquals("10 Min. schlummern", labels.snooze10m)
        assertEquals("1 Std. schlummern", labels.snooze1h)
        assertEquals("Aufgabenerinnerungen", labels.summary)
    }

    @Test
    fun fallsBackToEnglishForAnEmptyBlob() {
        val labels = ReminderNotificationLabels.parse("{}")
        assertEquals("Task reminder", labels.taskReminder)
        assertEquals("Due date reminder", labels.dueDateReminder)
        assertEquals("Done", labels.done)
        assertEquals("Snooze 10m", labels.snooze10m)
        assertEquals("Snooze 1h", labels.snooze1h)
        assertEquals("Task reminders", labels.summary)
    }

    @Test
    fun fallsBackToEnglishForMissingNullAndEmptyLabels() {
        val labels = ReminderNotificationLabels.parse(
            """{"taskReminder": "Aufgabenerinnerung", "done": null, "snooze10m": ""}"""
        )
        assertEquals("Aufgabenerinnerung", labels.taskReminder)
        assertEquals("Done", labels.done)
        assertEquals("Snooze 10m", labels.snooze10m)
        assertEquals("Snooze 1h", labels.snooze1h)
    }
}
