package com.rucola.app

import android.os.Bundle
import android.app.DatePickerDialog
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.viewmodel.compose.viewModel
import com.rucola.app.data.repository
import com.rucola.app.domain.*
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Calendar
import java.util.Date

private val RucolaBackground = Color(0xFFF4FAF1)
private val Sage = Color(0xFFD2E1B9)
private val Mint = Color(0xFFF0F9DC)
private val Olive = Color(0xFF8CA356)
private val Butter = Color(0xFFFFE397)
private val Moss = Color(0xFF8FC56A)
private val Ink = Color(0xFF10130F)
private val MutedInk = Color(0xFF7F887B)
private val Margarine = FontFamily(Font(R.font.margarine))
private val RucolaTypography = Typography().run {
    copy(
        displayLarge = displayLarge.copy(fontFamily = Margarine),
        headlineLarge = headlineLarge.copy(fontFamily = Margarine),
        headlineMedium = headlineMedium.copy(fontFamily = Margarine),
        titleLarge = titleLarge.copy(fontFamily = Margarine),
        bodyLarge = bodyLarge.copy(fontFamily = Margarine),
        bodyMedium = bodyMedium.copy(fontFamily = Margarine),
        labelLarge = labelLarge.copy(fontFamily = Margarine),
    )
}
    private fun colorFromHex(value: String): Color = Color(android.graphics.Color.parseColor(value))

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { RucolaApp(repository(applicationContext)) }
    }
}

@Composable
fun RucolaApp(repository: com.rucola.app.data.RucolaRepository) {
    val relationship by repository.relationship.collectAsState(null)
    val messages by repository.messages().collectAsState(emptyList())
    val scope = rememberCoroutineScope()
    var composer by remember { mutableStateOf(false) }
    var setupNickname by remember { mutableStateOf("") }
    val pager = rememberPagerState { 2 }

    MaterialTheme(
        colorScheme = lightColorScheme(background = RucolaBackground, surface = Butter, primary = Moss, onBackground = Ink, onSurface = Ink),
        typography = RucolaTypography,
    ) {
        if (relationship == null) {
            PairingScreen {
                SetupFlow { partnerNickname, ownName, partnerColor, togetherSince ->
                    scope.launch { repository.saveSetup(partnerNickname, ownName, partnerColor, togetherSince) }
                }
            }
        } else if (composer) {
            ComposerScreen(onBack = { composer = false }) { type, body -> scope.launch { repository.sendMessage(type, body); composer = false } }
        } else {
            HorizontalPager(state = pager, modifier = Modifier.fillMaxSize()) { page ->
                if (page == 0) HomeScreen(relationship!!, messages, onCompose = { composer = true })
                else HistoryScreen(messages)
            }
        }
    }
}

private enum class SetupStep { PARTNER_NAME, OWN_NAME, TOGETHER_SINCE }

@Composable
private fun SetupFlow(onSave: (String, String, String, Long?) -> Unit) {
    var step by rememberSaveable { mutableStateOf(SetupStep.PARTNER_NAME) }
    var partnerNickname by rememberSaveable { mutableStateOf("") }
    var ownName by rememberSaveable { mutableStateOf("") }
    var togetherSince by rememberSaveable { mutableStateOf<Long?>(null) }

    when (step) {
        SetupStep.PARTNER_NAME -> PartnerNameScreen(
            value = partnerNickname,
            onValueChange = { partnerNickname = it },
            onNext = { step = SetupStep.OWN_NAME },
        )
        SetupStep.OWN_NAME -> OwnNameScreen(
            value = ownName,
            onValueChange = { ownName = it },
            onBack = { step = SetupStep.PARTNER_NAME },
            onNext = { step = SetupStep.TOGETHER_SINCE },
        )
        SetupStep.TOGETHER_SINCE -> TogetherSinceScreen(
            you = ownName,
            partner = partnerNickname,
            selectedDate = togetherSince,
            onDateSelected = { togetherSince = it },
            onBack = { step = SetupStep.OWN_NAME },
            onFinish = { onSave(partnerNickname.trim(), ownName.trim(), "#8FC56A", togetherSince) },
        )
    }
}

@Composable
private fun PartnerNameScreen(value: String, onValueChange: (String) -> Unit, onNext: () -> Unit) {
    SetupScaffold(step = 1, total = 3, title = "Who are they?", subtitle = "this is how they'll appear to you in rucola.") {
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            placeholder = { Text("their nickname...") },
            singleLine = true,
            textStyle = LocalTextStyle.current.copy(fontFamily = Margarine, fontSize = 20.sp),
            shape = RoundedCornerShape(28.dp),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(24.dp))
        SetupNextButton("yep!", enabled = value.isNotBlank(), onClick = onNext)
    }
}

@Composable
private fun OwnNameScreen(value: String, onValueChange: (String) -> Unit, onBack: () -> Unit, onNext: () -> Unit) {
    SetupScaffold(step = 2, total = 3, title = "Who are you?", subtitle = "", onBack = onBack) {
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            placeholder = { Text("your name...") },
            singleLine = true,
            textStyle = LocalTextStyle.current.copy(fontFamily = Margarine, fontSize = 20.sp),
            shape = RoundedCornerShape(28.dp),
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(24.dp))
        SetupNextButton("that's me!", enabled = value.isNotBlank(), onClick = onNext)
    }
}

@Composable
private fun TogetherSinceScreen(
    you: String,
    partner: String,
    selectedDate: Long?,
    onDateSelected: (Long?) -> Unit,
    onBack: () -> Unit,
    onFinish: () -> Unit,
) {
    var showDatePicker by remember { mutableStateOf(false) }
    val calendar = remember { Calendar.getInstance() }
    val context = LocalContext.current
    LaunchedEffect(showDatePicker) {
        if (showDatePicker) {
            DatePickerDialog(
                context,
                { _, year, month, day ->
                    calendar.set(year, month, day, 12, 0, 0)
                    onDateSelected(calendar.timeInMillis)
                    showDatePicker = false
                },
                calendar.get(Calendar.YEAR),
                calendar.get(Calendar.MONTH),
                calendar.get(Calendar.DAY_OF_MONTH),
            ).also { it.setOnDismissListener { showDatePicker = false }; it.show() }
        }
    }
    SetupScaffold(
        step = 3,
        total = 3,
        title = "$you & $partner have been together since...",
        subtitle = "",
        onBack = onBack,
    ) {
        Button(
            onClick = { showDatePicker = true },
            colors = ButtonDefaults.buttonColors(containerColor = Mint, contentColor = Ink),
            shape = RoundedCornerShape(28.dp),
            modifier = Modifier.fillMaxWidth().height(64.dp),
        ) {
            Text(selectedDate?.let { DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(it)) } ?: "your date", fontSize = 18.sp)
        }
        Spacer(Modifier.height(20.dp))
        SetupNextButton("yep!", enabled = true, onClick = onFinish)
        Spacer(Modifier.height(20.dp))
        Text("or", color = MutedInk, fontSize = 14.sp)
        Spacer(Modifier.height(8.dp))
        OutlinedButton(
            onClick = { onDateSelected(null); onFinish() },
            shape = RoundedCornerShape(28.dp),
            modifier = Modifier.fillMaxWidth().height(60.dp),
        ) { Text("shh... not yet", color = Ink, fontSize = 18.sp) }
    }
}

@Composable
private fun SetupScaffold(step: Int, total: Int, title: String, subtitle: String, onBack: (() -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 28.dp, vertical = 34.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) TextButton(onClick = onBack) { Text("←", fontSize = 24.sp, color = Ink) }
            Spacer(Modifier.weight(1f))
            Text("$step / $total", color = MutedInk, fontSize = 14.sp)
        }
        Spacer(Modifier.height(54.dp))
        Text("rucola", fontSize = 48.sp, color = Ink, modifier = Modifier.rotate(-4f))
        Spacer(Modifier.height(42.dp))
        Text(title, fontSize = 27.sp, color = Ink, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        Spacer(Modifier.height(10.dp))
        Text(subtitle, fontSize = 15.sp, color = MutedInk, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        Spacer(Modifier.height(34.dp))
        content()
    }
}

@Composable
private fun SetupNextButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        enabled = enabled,
        colors = ButtonDefaults.buttonColors(containerColor = Butter, contentColor = Ink),
        shape = RoundedCornerShape(28.dp),
        modifier = Modifier.fillMaxWidth().height(60.dp),
    ) { Text(label, fontSize = 18.sp) }
}

@Composable
private fun HomeScreen(relationship: Relationship, messages: List<Message>, onCompose: () -> Unit) {
    val partner = messages.firstOrNull { it.participant == Participant.PARTNER && it.isActive }
    Column(Modifier.fillMaxSize().padding(horizontal = 22.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.height(28.dp))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Surface(color = colorFromHex(relationship.partnerColor), shape = RoundedCornerShape(50), modifier = Modifier.size(54.dp)) { Box(contentAlignment = Alignment.Center) { Text("♡", color = Ink, fontSize = 28.sp) } }
            Spacer(Modifier.width(12.dp))
            Column { Text(relationship.partnerNickname, fontSize = 23.sp, fontWeight = FontWeight.Bold); Text("a little something for you", color = MutedInk, fontSize = 14.sp) }
        }
        Spacer(Modifier.height(42.dp)); MessageBubble(partner, "Nothing waiting yet")
        Spacer(Modifier.weight(1f)); Text("swipe for our little history", color = MutedInk); Spacer(Modifier.height(14.dp))
        Button(onClick = onCompose, colors = ButtonDefaults.buttonColors(containerColor = Butter, contentColor = Ink), shape = RoundedCornerShape(26.dp), modifier = Modifier.width(170.dp).height(58.dp)) { Text("Send!  ↗", fontSize = 23.sp) }
        Spacer(Modifier.height(22.dp))
    }
}

@Composable
private fun MessageBubble(message: Message?, empty: String) {
    Surface(color = Sage, shape = RoundedCornerShape(topStart = 50.dp, topEnd = 72.dp, bottomEnd = 40.dp, bottomStart = 72.dp), modifier = Modifier.fillMaxWidth().heightIn(min = 270.dp).rotate(-2f)) {
        Box(Modifier.padding(32.dp), contentAlignment = Alignment.Center) { Text(message?.body ?: empty, fontSize = 39.sp, fontWeight = FontWeight.Medium, lineHeight = 45.sp) }
    }
}

@Composable
private fun ComposerScreen(onBack: () -> Unit, onSend: (MessageType, String) -> Unit) {
    var type by remember { mutableStateOf(MessageType.TEXT) }; var body by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().padding(24.dp)) {
        TextButton(onClick = onBack) { Text("← back", color = Ink) }; Text("Leave a little something", fontSize = 32.sp, fontWeight = FontWeight.Bold, color = Ink)
        Row(Modifier.padding(vertical = 20.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) { MessageType.values().forEach { option -> FilterChip(type == option, { type = option }, label = { Text(option.name.lowercase().replace('_', ' ')) }) } }
        if (type == MessageType.TEXT || type == MessageType.EMOJI) OutlinedTextField(body, { body = it }, label = { Text(if (type == MessageType.EMOJI) "Emoji" else "Your message") }, modifier = Modifier.fillMaxWidth(), minLines = 3, shape = RoundedCornerShape(22.dp))
        else Surface(color = Color(0xFFF0C95C), shape = RoundedCornerShape(28.dp), modifier = Modifier.fillMaxWidth().height(180.dp)) { Box(contentAlignment = Alignment.Center) { Text(if (type == MessageType.DRAWING) "✏ drawing space soon" else "📷 photo / video soon", fontSize = 23.sp) } }
        Spacer(Modifier.weight(1f)); Button({ onSend(type, body.ifBlank { if (type == MessageType.EMOJI) "🥺" else "[${type.name.lowercase()}]" }) }, colors = ButtonDefaults.buttonColors(containerColor = Butter, contentColor = Ink), enabled = type != MessageType.TEXT || body.isNotBlank(), modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(20.dp)) { Text("Send it  ↗", fontSize = 18.sp) }
    }
}

@Composable
private fun HistoryScreen(messages: List<Message>) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp)) {
        Text("Our little history", fontSize = 34.sp, fontWeight = FontWeight.Bold, color = Ink); Text("everything stays here", color = MutedInk); Spacer(Modifier.height(24.dp))
        messages.forEach { message ->
            Text(DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(message.createdAt)), color = MutedInk, fontSize = 13.sp, modifier = Modifier.padding(start = 10.dp, top = 8.dp))
            Surface(color = if (message.participant == Participant.ME) Butter else Sage, shape = RoundedCornerShape(topStart = 32.dp, topEnd = 46.dp, bottomEnd = 32.dp, bottomStart = 46.dp), modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp).rotate(if (message.participant == Participant.ME) 1f else -1f)) { Column(Modifier.padding(20.dp)) { Text(if (message.participant == Participant.ME) "You" else "${message.participant}", fontWeight = FontWeight.Bold, color = MutedInk); Text(message.body, fontSize = 20.sp) } }
        }
    }
}

private enum class PairingMode { ENTER_CODE, SHOW_CODE }

@Composable
private fun PairingScreen(onContinueToSetup: @Composable () -> Unit) {
    var mode by rememberSaveable { mutableStateOf(PairingMode.ENTER_CODE) }
    var inviteCode by rememberSaveable { mutableStateOf("") }
    var connected by rememberSaveable { mutableStateOf(false) }

    if (connected) {
        onContinueToSetup()
        return
    }

    Box(Modifier.fillMaxSize().background(RucolaBackground)) {
        PairingPatternPlaceholder(Modifier.fillMaxSize())
        Box(
            Modifier
                .fillMaxWidth()
                .fillMaxHeight(.7f)
                .align(Alignment.BottomCenter)
                .rotate(-8f)
                .offset(y = 72.dp)
                .background(Sage),
        )
        when (mode) {
            PairingMode.ENTER_CODE -> EnterPairingCode(
                code = inviteCode,
                onCodeChange = { inviteCode = it },
                onShareOwnCode = { mode = PairingMode.SHOW_CODE },
                onConnect = { if (inviteCode.isNotBlank()) connected = true },
            )
            PairingMode.SHOW_CODE -> ShowPairingCode(onBack = { mode = PairingMode.ENTER_CODE }, onContinue = { connected = true })
        }
    }
}

@Composable
private fun EnterPairingCode(code: String, onCodeChange: (String) -> Unit, onShareOwnCode: () -> Unit, onConnect: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(horizontal = 28.dp, vertical = 78.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(20.dp))
        PairingLogoPlaceholder()
        Spacer(Modifier.height(12.dp))
        Text("rucola", fontSize = 36.sp, color = Ink)
        Text("connect to someone <3", fontSize = 16.sp, color = Ink.copy(alpha = .45f))
        Spacer(Modifier.height(190.dp))
        OutlinedTextField(
            value = code,
            onValueChange = onCodeChange,
            placeholder = { Text("type their invite code here!", color = Ink.copy(alpha = .33f), fontSize = 18.sp) },
            singleLine = true,
            textStyle = LocalTextStyle.current.copy(fontFamily = Margarine, fontSize = 18.sp),
            shape = RoundedCornerShape(50),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = Olive,
                unfocusedBorderColor = Olive,
                focusedContainerColor = Mint,
                unfocusedContainerColor = Mint,
            ),
            modifier = Modifier.fillMaxWidth().height(72.dp),
        )
        Spacer(Modifier.height(64.dp))
        Text("otherwise", fontSize = 14.sp, color = Ink.copy(alpha = .45f))
        Spacer(Modifier.height(14.dp))
        PairingAction("share yours with them", onShareOwnCode, Modifier.fillMaxWidth(.82f))
        Spacer(Modifier.weight(1f))
        PairingAction("connect", onConnect, Modifier.fillMaxWidth(.65f), enabled = code.isNotBlank())
    }
}

@Composable
private fun ShowPairingCode(onBack: () -> Unit, onContinue: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(horizontal = 28.dp, vertical = 44.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            PairingLogoPlaceholder(Modifier.size(58.dp))
            Spacer(Modifier.width(14.dp))
            Text("your invite code", fontSize = 19.sp, color = Ink)
        }
        Spacer(Modifier.height(134.dp))
        Text("this is your magic code!", fontSize = 25.sp, color = Ink)
        Spacer(Modifier.height(40.dp))
        Surface(color = Mint, shape = RoundedCornerShape(50), modifier = Modifier.fillMaxWidth(.82f).height(70.dp)) {
            Box(contentAlignment = Alignment.Center) { Text("🔥💖❣️😽🥰", fontSize = 26.sp) }
        }
        Spacer(Modifier.height(26.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            PairingAction("copy", {}, Modifier.width(128.dp), dark = true)
            PairingAction("share", {}, Modifier.width(128.dp), dark = true)
        }
        Spacer(Modifier.weight(1f))
        Text("your other person can type this\ncode to connect with you!", fontSize = 14.sp, color = Ink.copy(alpha = .65f), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        Spacer(Modifier.height(26.dp))
        TextButton(onClick = onBack) { Text("← enter their code", color = Ink.copy(alpha = .7f)) }
        PairingAction("continue", onContinue, Modifier.fillMaxWidth(.6f))
    }
}

@Composable
private fun PairingAction(label: String, onClick: () -> Unit, modifier: Modifier, enabled: Boolean = true, dark: Boolean = false) {
    Button(
        onClick = onClick,
        enabled = enabled,
        colors = ButtonDefaults.buttonColors(
            containerColor = if (dark) Olive else Mint,
            contentColor = if (dark) Color.White else Ink,
            disabledContainerColor = Mint.copy(alpha = .55f),
            disabledContentColor = Ink.copy(alpha = .4f),
        ),
        shape = RoundedCornerShape(50),
        contentPadding = PaddingValues(horizontal = 20.dp),
        modifier = modifier.height(58.dp),
    ) {
        Text(label, fontSize = 17.sp)
        if (label == "share yours with them") Text("  →", fontSize = 24.sp)
    }
}

@Composable
private fun PairingLogoPlaceholder(modifier: Modifier = Modifier.size(94.dp)) {
    Box(modifier.background(Mint, RoundedCornerShape(32.dp)), contentAlignment = Alignment.Center) {
        Text("♡", color = Color(0xFF25B84B), fontSize = 58.sp)
    }
}

@Composable
private fun PairingPatternPlaceholder(modifier: Modifier) {
    Canvas(modifier) {
        var y = 30f
        while (y < size.height) {
            drawCircle(color = Color(0xFFDFEED7), center = androidx.compose.ui.geometry.Offset(24f, y), radius = 18f, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 2f))
            y += 92f
        }
    }
}

@Composable
fun PairingPreview() {
    MaterialTheme(
        colorScheme = lightColorScheme(background = RucolaBackground, surface = Butter, primary = Moss, onBackground = Ink, onSurface = Ink),
        typography = RucolaTypography,
    ) {
        PairingScreen(onContinueToSetup = {})
    }
}