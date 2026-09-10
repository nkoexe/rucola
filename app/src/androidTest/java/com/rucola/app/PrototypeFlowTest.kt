package com.rucola.app

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Rule
import org.junit.Test

class PrototypeFlowTest {
    @get:Rule val composeRule = createComposeRule()

    @Test fun pairingScreenShowsInviteActions() {
        composeRule.setContent { PairingPreview() }
        composeRule.onNodeWithText("type their invite code here!").assertExists()
        composeRule.onNodeWithText("share yours with them").assertExists()
    }
}