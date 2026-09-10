package com.rucola.app.domain

enum class Participant { ME, PARTNER }
enum class MessageType { TEXT, EMOJI, PHOTO_VIDEO, DRAWING }
enum class SyncState { LOCAL_ONLY, PENDING, SYNCED, FAILED }

data class Relationship(
    val id: String = "the-one",
    val partnerNickname: String,
    val avatar: String,
    val togetherSince: Long? = null,
)

data class Message(
    val id: String,
    val relationshipId: String,
    val participant: Participant,
    val type: MessageType,
    val body: String,
    val createdAt: Long,
    val isActive: Boolean,
    val syncState: SyncState = SyncState.LOCAL_ONLY,
)