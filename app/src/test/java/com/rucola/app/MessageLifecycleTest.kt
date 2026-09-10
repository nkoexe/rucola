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

private class MemoryRepository : RucolaRepository {
    private val relationshipState = MutableStateFlow<Relationship?>(Relationship("the-one", "Mina", "🌱"))
    private val values = mutableListOf<Message>()
    override val relationship: Flow<Relationship?> = relationshipState
    override fun messages(): Flow<List<Message>> = MutableStateFlow(values).map { it.sortedByDescending(Message::createdAt) }
    override suspend fun saveSetup(nickname: String, avatar: String, togetherSince: Long?) { relationshipState.value = Relationship("the-one", nickname, avatar, togetherSince) }
    override suspend fun sendMessage(type: MessageType, body: String) { values.replaceAll { if (it.participant == Participant.ME && it.isActive) it.copy(isActive = false) else it }; values += Message("${values.size}", "the-one", Participant.ME, type, body, values.size.toLong(), true, SyncState.PENDING) }
}

class MessageLifecycleTest {
    @Test fun sendingSecondMessageArchivesFirstAndOrdersNewestFirst() = runBlocking {
        val repository = MemoryRepository(); repository.sendMessage(MessageType.TEXT, "first"); repository.sendMessage(MessageType.EMOJI, "🥺")
        val result = repository.messages().firstValue()
        assertEquals(listOf("🥺", "first"), result.map { it.body }); assertTrue(result.first().isActive); assertFalse(result.last().isActive)
    }

    private suspend fun <T> Flow<T>.firstValue(): T = first()
}