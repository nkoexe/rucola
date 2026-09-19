import { useEffect, useMemo, useState } from 'react';
import { Share, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Relationship } from '../../domain/models';
import { cloudRuntime } from '../../cloud/CloudRuntime';
import { isValidPairingConfirmationCode } from '../../cloud/pairingCode';
import type { PendingPairingView } from '../../cloud/PairingManager';

type Props = {
  relationship: Relationship;
  onComplete: (relationship: Relationship) => void;
};

type Mode = 'loading' | 'choice' | 'create' | 'join';

export function PairingScreen({ relationship, onComplete }: Props) {
  const [mode, setMode] = useState<Mode>('loading');
  const [pending, setPending] = useState<PendingPairingView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    void (async () => {
      try {
        const pendingPairing = await cloudRuntime.resumePendingPairing();
        if (!mounted) return;
        if (pendingPairing) {
          setPending(pendingPairing);
          setMode('create');
          return;
        }

        const identity = await cloudRuntime.loadIdentity();
        if (!mounted) return;
        if (identity?.state === 'ACTIVE') {
          onComplete(relationship);
          return;
        }

        setMode('choice');
      } catch (cause) {
        if (!mounted) return;
        setError(toUserMessage(cause));
        setMode('choice');
      }
    })();

    return () => {
      mounted = false;
    };
  }, [onComplete, relationship]);

  useEffect(() => {
    if (mode !== 'create' || !pending) return;

    let mounted = true;
    const check = async () => {
      if (pending.expiresAt <= Date.now()) {
        await cloudRuntime.cancelPendingPairing();
        if (mounted) {
          setPending(null);
          setError('This pairing pass expired. Make a new one to try again.');
          setMode('choice');
        }
        return;
      }

      try {
        const identity = await cloudRuntime.refreshRelationshipState();
        if (!mounted) return;
        if (identity?.state === 'ACTIVE') {
          onComplete(relationship);
        }
      } catch (cause) {
        if (mounted) setError(toUserMessage(cause));
      }
    };

    void check();
    const timer = setInterval(() => void check(), 2500);

    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [mode, onComplete, pending, relationship]);

  const start = async () => {
    setError(null);
    setMode('create');
    try {
      const next = await cloudRuntime.startPairing(15 * 60);
      setPending(next);
    } catch (cause) {
      setMode('choice');
      setError(toUserMessage(cause));
    }
  };

  const cancel = async () => {
    await cloudRuntime.cancelPendingPairing();
    setPending(null);
    setError(null);
    setMode('choice');
  };

  if (mode === 'loading') return <PairingLoading />;
  if (mode === 'create' && pending) {
    return <CreatePairing pending={pending} error={error} onShare={sharePairingPass} onCancel={() => void cancel()} />;
  }
  if (mode === 'create') return <PairingLoading />;
  if (mode === 'join') return <JoinPairing error={error} onBack={() => { setError(null); setMode('choice'); }} onComplete={() => onComplete(relationship)} />;
  return (
    <ChoiceScreen
      relationship={relationship}
      error={error}
      onCreate={() => void start()}
      onJoin={() => { setError(null); setMode('join'); }}
      onContinue={() => onComplete(relationship)}
    />
  );
}

function PairingLoading() {
  return (
    <View style={styles.container}>
      <Text style={styles.logo}>rucola</Text>
      <Text style={styles.heading}>getting things ready...</Text>
    </View>
  );
}

function ChoiceScreen({ relationship, error, onCreate, onJoin, onContinue }: {
  relationship: Relationship;
  error: string | null;
  onCreate: () => void;
  onJoin: () => void;
  onContinue: () => void;
}) {
  return (
    <View style={styles.container}>
      <Text style={styles.logo}>rucola</Text>
      <Text style={styles.heading}>connect with {relationship.partnerNickname}</Text>
      <Text style={styles.body}>pair the two phones so you can leave things for each other over the internet.</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <ActionButton label="create pairing" onPress={onCreate} />
      <ActionButton label="join pairing" onPress={onJoin} secondary />
      <Text style={styles.or}>or</Text>
      <Text style={styles.offlineLink} onPress={onContinue}>keep using it on this phone</Text>
    </View>
  );
}

function CreatePairing({ pending, error, onShare, onCancel }: {
  pending: PendingPairingView;
  error: string | null;
  onShare: () => void;
  onCancel: () => void;
}) {
  const remaining = useRemainingTime(pending.expiresAt);

  return (
    <View style={styles.container}>
      <Text style={styles.logo}>rucola</Text>
      <Text style={styles.heading}>show this to your person</Text>
      <Text style={styles.emojiCode}>{pending.confirmationCode}</Text>
      <Text style={styles.body}>First, send the pairing pass with Quick Share. Then tell them these five emojis are the ones to enter.</Text>
      <ActionButton label="share pairing pass" onPress={onShare} />
      <Text style={styles.securityNote}>The pairing pass contains the connection key. Use Quick Share or another direct, trusted transfer — not a chat, post, or cloud note.</Text>
      <Text style={styles.waiting}>waiting for them... {formatRemaining(remaining)}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Text style={styles.link} onPress={onCancel}>cancel pairing</Text>
    </View>
  );
}

function JoinPairing({ error, onBack, onComplete }: {
  error: string | null;
  onBack: () => void;
  onComplete: () => void;
}) {
  const [pairingPass, setPairingPass] = useState('');
  const [confirmationCode, setConfirmationCode] = useState('');
  const [working, setWorking] = useState(false);
  const validCode = isValidPairingConfirmationCode(confirmationCode);

  const accept = async () => {
    if (working || !pairingPass.trim() || !validCode) return;
    setWorking(true);
    try {
      await cloudRuntime.acceptPairingPackage(pairingPass.trim(), confirmationCode);
      onComplete();
    } catch (cause) {
      setErrorText(cause);
    } finally {
      setWorking(false);
    }
  };

  const [localError, setLocalError] = useState<string | null>(null);
  const visibleError = localError ?? error;

  return (
    <View style={styles.container}>
      <Text style={styles.logo}>rucola</Text>
      <Text style={styles.heading}>connect to your person</Text>
      <Text style={styles.body}>Paste the pairing pass they sent you, then enter the five emojis they see on their phone.</Text>

      <Text style={styles.label}>pairing pass</Text>
      <TextInput
        value={pairingPass}
        onChangeText={(value) => { setLocalError(null); setPairingPass(value); }}
        placeholder="rucola-pairing:v1...."
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        textContentType="none"
        style={[styles.input, styles.passInput]}
      />

      <Text style={styles.label}>five emojis</Text>
      <TextInput
        value={confirmationCode}
        onChangeText={(value) => { setLocalError(null); setConfirmationCode(value); }}
        placeholder="😀 😃 😄 😁 😆"
        autoCorrect={false}
        style={[styles.input, styles.emojiInput]}
      />

      {!confirmationCode.trim() || validCode ? null : <Text style={styles.error}>Use exactly five of the pairing emojis.</Text>}
      {visibleError ? <Text style={styles.error}>{visibleError}</Text> : null}

      <ActionButton
        label={working ? 'connecting...' : 'connect them'}
        onPress={() => void accept()}
        disabled={working || !pairingPass.trim() || !validCode}
      />
      <Text style={styles.link} onPress={onBack}>‹ back</Text>
    </View>
  );

  function setErrorText(cause: unknown) {
    setLocalError(toUserMessage(cause));
  }
}

function ActionButton({ label, onPress, secondary = false, disabled = false }: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return (
    <View
      style={[styles.button, secondary && styles.secondaryButton, disabled && styles.disabled]}
      accessible
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      onTouchEnd={disabled ? undefined : onPress}
    >
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{label}</Text>
    </View>
  );
}

function sharePairingPass(pending: PendingPairingView) {
  return () => {
    void Share.share({
      title: 'Rucola pairing pass',
      message: pending.package,
    }).catch(() => {
      // The native share sheet can be cancelled. Do not surface a secret or raw package in diagnostics.
    });
  };
}

function useRemainingTime(expiresAt: number) {
  const [remaining, setRemaining] = useState(() => Math.max(0, expiresAt - Date.now()));

  useEffect(() => {
    const timer = setInterval(() => setRemaining(Math.max(0, expiresAt - Date.now())), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  return remaining;
}

function formatRemaining(milliseconds: number) {
  const seconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `(${minutes}:${String(rest).padStart(2, '0')})`;
}

function toUserMessage(cause: unknown) {
  const code = cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code?: unknown }).code) : '';
  if (code === 'PAIRING_RATE_LIMITED') return 'Too many incorrect tries. Please wait and try again.';
  if (code === 'INVALID_INVITATION') return 'That pairing pass or emoji code does not match.';
  if (code === 'CLIENT_NETWORK_ERROR' || code === 'CLIENT_TIMEOUT') return 'Rucola could not reach the service. Check your connection and try again.';
  return cause instanceof Error ? cause.message : 'Pairing could not be completed.';
}

function ActionSpacer() {
  return null;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F3F6E9', padding: 28, justifyContent: 'center' },
  logo: { fontSize: 42, fontWeight: '800', alignSelf: 'center', marginBottom: 44 },
  heading: { fontSize: 30, fontWeight: '800', lineHeight: 36, marginBottom: 16 },
  body: { fontSize: 17, lineHeight: 25, opacity: 0.72, marginBottom: 24 },
  emojiCode: { fontSize: 40, letterSpacing: 4, marginBottom: 24 },
  waiting: { marginTop: 24, fontSize: 17, fontWeight: '700', opacity: 0.75 },
  label: { fontSize: 14, fontWeight: '700', marginTop: 10, marginBottom: 8, opacity: 0.6 },
  input: { borderWidth: 1, borderColor: '#A9B7A2', borderRadius: 14, backgroundColor: '#FCFDF7', paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 },
  passInput: { minHeight: 110, textAlignVertical: 'top', fontFamily: 'monospace' },
  emojiInput: { fontSize: 22, letterSpacing: 2 },
  button: { alignSelf: 'stretch', marginTop: 14, borderRadius: 18, backgroundColor: '#1D2A1B', paddingHorizontal: 22, paddingVertical: 15 },
  buttonText: { color: '#F3F6E9', textAlign: 'center', fontSize: 17, fontWeight: '800' },
  secondaryButton: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#1D2A1B' },
  secondaryButtonText: { color: '#1D2A1B' },
  disabled: { opacity: 0.35 },
  error: { marginTop: 10, color: '#9B2C2C', lineHeight: 20 },
  securityNote: { marginTop: 14, fontSize: 13, lineHeight: 19, opacity: 0.55 },
  or: { textAlign: 'center', marginVertical: 16, opacity: 0.55 },
  link: { marginTop: 22, textDecorationLine: 'underline', fontSize: 17 },
  offlineLink: { textAlign: 'center', textDecorationLine: 'underline', fontSize: 17 },
});
