package com.rucola.app

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.rucola.app.data.*
import com.rucola.app.domain.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class RoomPersistenceTest {
    private lateinit var database: RucolaDatabase

    @Before
    fun setUp() {
        database = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), RucolaDatabase::class.java)
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun tearDown() = database.close()

    @Test
    fun replacingOwnMessageAtomicallyArchivesThePreviousMessage() = runBlocking {
        val dao = database.dao()
        dao.replaceActive(Message("one", "the-one", Participant.ME, MessageType.TEXT, "hello", 1, true).toEntity())
        dao.replaceActive(Message("two", "the-one", Participant.ME, MessageType.EMOJI, "♡", 2, true).toEntity())

        val stored = dao.messages("the-one").first()
        assertEquals(listOf("♡", "hello"), stored.map { it.body })
        assertTrue(stored.first().isActive)
        assertFalse(stored.last().isActive)
    }

    @Test
    fun replacingOwnMessageKeepsBothParticipantsAndHistory() = runBlocking {
        val dao = database.dao()
        dao.replaceActive(Message("partner", "the-one", Participant.PARTNER, MessageType.TEXT, "hello", 1, true, orderIndex = 1).toEntity())
        dao.replaceActive(Message("first", "the-one", Participant.ME, MessageType.TEXT, "first", 2, true, orderIndex = 2).toEntity())
        dao.replaceActive(Message("second", "the-one", Participant.ME, MessageType.EMOJI, "♡", 3, true, orderIndex = 3).toEntity())

        val stored = dao.messages("the-one").first()
        assertEquals(listOf("♡", "first", "hello"), stored.map { it.body })
        assertEquals(1, stored.count { it.participant == Participant.ME.name && it.isActive })
        assertEquals(1, stored.count { it.participant == Participant.PARTNER.name && it.isActive })
        assertFalse(stored.single { it.id == "first" }.isActive)
    }

    @Test
    fun incomingSequencePreservesHistoryAndMakesOnlyTheLatestMessageActive() = runBlocking {
        val dao = database.dao()
        listOf("A", "B", "C").forEachIndexed { index, body ->
            dao.replaceActive(
                Message(
                    id = body,
                    relationshipId = "the-one",
                    participant = Participant.PARTNER,
                    type = MessageType.TEXT,
                    body = body,
                    createdAt = index.toLong(),
                    orderIndex = index.toLong(),
                    isActive = true,
                ).toEntity(),
            )
        }

        val stored = dao.messages("the-one").first()
        assertEquals(listOf("C", "B", "A"), stored.map { it.body })
        assertEquals(listOf(true, false, false), stored.map { it.isActive })
    }

    @Test
    fun outOfOrderAndDuplicateIncomingMessagesDoNotDisplaceTheNewestActiveMessage() = runBlocking {
        val dao = database.dao()
        val newest = Message("C", "the-one", Participant.PARTNER, MessageType.TEXT, "C", 3, true, orderIndex = 3)
        dao.replaceActive(newest.toEntity())
        dao.replaceActive(Message("A", "the-one", Participant.PARTNER, MessageType.TEXT, "A", 1, true, orderIndex = 1).toEntity())
        dao.replaceActive(Message("B", "the-one", Participant.PARTNER, MessageType.TEXT, "B", 2, true, orderIndex = 2).toEntity())
        dao.replaceActive(newest.toEntity())

        val stored = dao.messages("the-one").first()
        assertEquals(listOf("C", "B", "A"), stored.map { it.body })
        assertEquals(listOf("C"), stored.filter { it.isActive }.map { it.id })
    }
}
