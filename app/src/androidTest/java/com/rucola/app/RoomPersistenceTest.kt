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
        database = Room.inMemoryDatabaseBuilder<RucolaDatabase>(ApplicationProvider.getApplicationContext())
            .allowMainThreadQueries()
            .build()
    }

    @After
    fun tearDown() = database.close()

    @Test
    fun messagesPersistAndOnlyNewestOwnMessageIsActive() = runBlocking {
        val dao = database.dao()
        dao.insertMessage(Message("one", "the-one", Participant.ME, MessageType.TEXT, "hello", 1, true).toEntity())
        dao.archiveActive("the-one", Participant.ME.name)
        dao.insertMessage(Message("two", "the-one", Participant.ME, MessageType.EMOJI, "♡", 2, true).toEntity())

        val stored = dao.messages("the-one").first()
        assertEquals(listOf("♡", "hello"), stored.map { it.body })
        assertTrue(stored.first().isActive)
        assertFalse(stored.last().isActive)
    }
}