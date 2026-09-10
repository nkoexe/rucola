package com.rucola.app.data

import android.content.Context
import androidx.room.Room
import com.rucola.app.domain.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import java.util.UUID

interface RucolaRepository {
    val relationship: Flow<Relationship?>
    fun messages(): Flow<List<Message>>
    suspend fun saveSetup(nickname: String, avatar: String, togetherSince: Long?)
    suspend fun sendMessage(type: MessageType, body: String)
}

class RoomRucolaRepository(private val dao: RucolaDao) : RucolaRepository {
    override val relationship = dao.relationship().map { it?.toDomain() }
    override fun messages() = dao.messages("the-one").map { rows -> rows.map { it.toDomain() } }

    override suspend fun saveSetup(nickname: String, avatar: String, togetherSince: Long?) {
        dao.saveRelationship(RelationshipEntity("the-one", nickname, avatar, togetherSince))
        if (dao.messageCount("the-one") == 0) {
            dao.insertMessage(
                Message(
                    "seed-partner-message",
                    "the-one",
                    Participant.PARTNER,
                    MessageType.TEXT,
                    "good luck today ♡",
                    System.currentTimeMillis(),
                    true,
                    SyncState.LOCAL_ONLY,
                ).toEntity(),
            )
        }
    }

    override suspend fun sendMessage(type: MessageType, body: String) {
        dao.archiveActive("the-one", Participant.ME.name)
        dao.insertMessage(Message(UUID.randomUUID().toString(), "the-one", Participant.ME, type, body, System.currentTimeMillis(), true, SyncState.PENDING).toEntity())
    }
}

fun repository(context: Context): RucolaRepository {
    val db = Room.databaseBuilder(context, RucolaDatabase::class.java, "rucola.db").build()
    return RoomRucolaRepository(db.dao())
}