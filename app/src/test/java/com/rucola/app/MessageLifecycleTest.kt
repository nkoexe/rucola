package com.rucola.app

import com.rucola.app.data.*
import com.rucola.app.domain.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.util.Calendar

private class MemoryRepository : RucolaRepository {
    private val relationshipState = MutableStateFlow<Relationship?>(Relationship(id = "the-one", partnerNickname = "Mina"))
    private val values = mutableListOf<Message>()
    override val relationship: Flow<Relationship?> = relationshipState
    override fun messages(): Flow<List<Message>> = MutableStateFlow(values).map { it.sortedByDescending(Message::createdAt) }
    override suspend fun saveSetup(partnerNickname: String, ownName: String, partnerColor: String, togetherSince: Long?) { relationshipState.value = Relationship("the-one", partnerNickname, ownName, partnerColor, togetherSince) }
    override suspend fun sendMessage(type: MessageType, body: String, mediaReference: String?) { values.replaceAll { if (it.participant == Participant.ME && it.isActive) it.copy(isActive = false) else it }; values += Message("${values.size}", "the-one", Participant.ME, type, body, values.size.toLong(), true, SyncState.PENDING, values.size.toLong(), mediaReference) }
}

class MessageLifecycleTest {
    @Test fun sendingSecondMessageArchivesFirstAndOrdersNewestFirst() = runBlocking {
        val repository = MemoryRepository(); repository.sendMessage(MessageType.TEXT, "first"); repository.sendMessage(MessageType.EMOJI, "🥺")
        val result = repository.messages().firstValue()
        assertEquals(listOf("🥺", "first"), result.map { it.body }); assertTrue(result.first().isActive); assertFalse(result.last().isActive)
    }

    private suspend fun <T> Flow<T>.firstValue(): T = first()
}

class MessageRulesTest {
    @Test fun textAndEmojiMessagesNeedContent() {
        assertThrows(IllegalArgumentException::class.java) { validateMessage(MessageType.TEXT, " ") }
        assertThrows(IllegalArgumentException::class.java) { validateMessage(MessageType.EMOJI, "") }
    }

    @Test fun mediaMessagesCanBeMediaOnlyWhenTheyHaveAReference() {
        validateMessage(MessageType.PHOTO_VIDEO, "", "local://photo")
        validateMessage(MessageType.DRAWING, "", "local://drawing")
    }

    @Test fun mediaPlaceholdersCanUseTextUntilEditorsExist() {
        validateMessage(MessageType.PHOTO_VIDEO, "[photo_video]")
        validateMessage(MessageType.DRAWING, "[drawing]")
    }

    @Test fun historyDateLabelsRepeatOnlyWhenTheCalendarDayChanges() {
        val morning = Calendar.getInstance().apply {
            set(2026, Calendar.SEPTEMBER, 11, 9, 0, 0)
        }.timeInMillis
        val evening = Calendar.getInstance().apply {
            set(2026, Calendar.SEPTEMBER, 11, 21, 0, 0)
        }.timeInMillis
        val nextDay = Calendar.getInstance().apply {
            set(2026, Calendar.SEPTEMBER, 12, 0, 5, 0)
        }.timeInMillis

        assertTrue(sameCalendarDay(morning, evening))
        assertFalse(sameCalendarDay(evening, nextDay))
    }
}