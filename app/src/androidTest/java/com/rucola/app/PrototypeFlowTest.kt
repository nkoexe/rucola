package com.rucola.app

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import org.junit.Rule
import org.junit.Test

class PrototypeFlowTest {
    @get:Rule val composeRule = createComposeRule()

    @Test fun setupShowsNicknameAndMailboxAction() {
        composeRule.setContent { SetupPreview() }
        composeRule.onNodeWithText("Partner nickname").assertExists()
        composeRule.onNodeWithText("Open our mailbox").assertExists()
    }
}