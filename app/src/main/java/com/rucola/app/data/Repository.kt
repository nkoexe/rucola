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
    suspend fun saveSetup(partnerNickname: String, ownName: String, partnerColor: String, togetherSince: Long?)
    suspend fun sendMessage(type: MessageType, body: String, mediaReference: String? = null)
}

class RoomRucolaRepository(private val dao: RucolaDao) : RucolaRepository {
    override val relationship = dao.relationship("the-one").map { it?.toDomain() }
    override fun messages() = dao.messages("the-one").map { rows -> rows.map { it.toDomain() } }

    override suspend fun saveSetup(partnerNickname: String, ownName: String, partnerColor: String, togetherSince: Long?) {
        dao.saveRelationship(RelationshipEntity("the-one", partnerNickname, ownName, partnerColor, togetherSince))
        if (dao.messageCount("the-one") == 0) {
            dao.replaceActive(
                Message(
                    id = "seed-partner-message",
                    relationshipId = "the-one",
                    participant = Participant.PARTNER,
                    type = MessageType.TEXT,
                    body = "good luck today ♡",
                    createdAt = System.currentTimeMillis(),
                    isActive = true,
                    syncState = SyncState.LOCAL_ONLY,
                    orderIndex = 1,
                ).toEntity(),
            )
        }
    }

    override suspend fun sendMessage(type: MessageType, body: String, mediaReference: String?) {
        validateMessage(type, body, mediaReference)
        dao.replaceActive(
            Message(
                id = UUID.randomUUID().toString(),
                relationshipId = "the-one",
                participant = Participant.ME,
                type = type,
                body = body,
                createdAt = System.currentTimeMillis(),
                orderIndex = dao.nextOrderIndex("the-one"),
                isActive = true,
                mediaReference = mediaReference,
                syncState = SyncState.PENDING,
            ).toEntity(),
        )
    }
}

fun repository(context: Context): RucolaRepository {
    val db = Room.databaseBuilder(context, RucolaDatabase::class.java, "rucola.db")
        .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4)
        .build()
    return RoomRucolaRepository(db.dao())
}
