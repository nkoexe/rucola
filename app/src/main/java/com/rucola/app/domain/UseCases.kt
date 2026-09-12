package com.rucola.app.domain

import com.rucola.app.data.RucolaRepository

fun validateMessage(type: MessageType, body: String, mediaReference: String? = null) {
    when (type) {
        MessageType.TEXT -> require(body.isNotBlank()) { "Text messages need a message body" }
        MessageType.EMOJI -> require(body.isNotBlank()) { "Emoji messages need an emoji" }
        MessageType.PHOTO_VIDEO, MessageType.DRAWING -> require(body.isNotBlank() || !mediaReference.isNullOrBlank()) {
            "Media messages need text or a media reference"
        }
    }
}

class SaveSetup(private val repository: RucolaRepository) {
    suspend operator fun invoke(
        partnerNickname: String,
        ownName: String,
        partnerColor: String,
        togetherSince: Long?,
    ) = repository.saveSetup(partnerNickname, ownName, partnerColor, togetherSince)
}

class SendMessage(private val repository: RucolaRepository) {
    suspend operator fun invoke(type: MessageType, body: String, mediaReference: String? = null) {
        validateMessage(type, body, mediaReference)
        repository.sendMessage(type, body, mediaReference)
    }
}
