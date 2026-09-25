import { useEffect, useRef, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Relationship } from '../../domain/models';
import { cloudRuntime } from '../../cloud/CloudRuntime';
import { isValidPairingConfirmationCode } from '../../cloud/pairingCode';
import type { PairingInput, PairingInvitationView } from '../../cloud/pairingTransport';

type Props = {
  relationship: Relationship;
  onComplete: (relationship: Relationship) => void;
  onBack?: () => void;
  initialPairingInput?: PairingInput | null;
  onPairingInputHandled?: () => void;
};

type Mode = 'loading' | 'choice' | 'create' | 'join' | 'joining';

export function PairingScreen({
  relationship,
  onComplete,
  onBack,
  initialPairingInput,
  onPairingInputHandled,
}: Props) {
  const [mode, setMode] = useState<Mode>('loading');
  const [pending, setPending] = useState<PairingInvitationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairingProgress, setPairingProgress] = useState<number | null>(null);
  const initialized = useRef(false);
  const externalStarted = useRef(false);
  const completionStartedFor = useRef<string | null>(null);
  const onCompleteRef = useRef(onComplete);
  const onPairingInputHandledRef = useRef(onPairingInputHandled);

  onCompleteRef.current = onComplete;
  onPairingInputHandledRef.current = onPairingInputHandled;

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    let mounted = true;

    void (async () => {
      try {
        // A creator stores its ME/PAIRING identity before the handshake finishes.
        // Resume that initiator state first; responder recovery rejects an existing
        // identity by design and must only run when no initiator pairing exists.
        const pendingPairing = await cloudRuntime.resumePendingPairingInvitation((progress) => {
          setPairingProgress(progress);
        });
        if (!mounted) return;
        if (pendingPairing) {
          setPending(pendingPairing);
          setPairingProgress(null);
          setMode('create');
          return;
        }

        const resumedPartner = await cloudRuntime.resumePendingPartnerPairing();
        if (!mounted) return;
        if (resumedPartner) {
          onCompleteRef.current(relationship);
          return;
        }

        setPairingProgress(null);
        setMode('choice');
      } catch (cause) {
        if (!mounted) return;
        setPairingProgress(null);
        setPairingProgress(null);
        setError(toUserMessage(cause));
        setMode('choice');
      }
    })();

    return () => {
      mounted = false;
    };
  }, [relationship]);

  useEffect(() => {
    if (
      !initialPairingInput ||
      externalStarted.current ||
      mode === 'loading' ||
      mode === 'create'
    ) return;

    externalStarted.current = true;
    setError(null);
    setPairingProgress(0);
    setMode('joining');
    onPairingInputHandledRef.current?.();

    let mounted = true;
    void cloudRuntime.acceptPairingInput(initialPairingInput, (progress) => {
      if (mounted) setPairingProgress(progress);
    })
      .then(() => {
        if (mounted) {
          setPairingProgress(null);
          onCompleteRef.current(relationship);
        }
      })
      .catch((cause) => {
        if (!mounted) return;
        setError(toUserMessage(cause));
        setMode('choice');
      });

    return () => {
      mounted = false;
    };
  }, [initialPairingInput, mode, relationship]);

  useEffect(() => {
    if (mode !== 'create' || !pending) return;

    const key = pending.pairingCode + ':' + pending.expiresAt;
    if (completionStartedFor.current === key) return;
    completionStartedFor.current = key;

    let mounted = true;
    void cloudRuntime.completePendingPairing()
      .then((identity) => {
        if (!mounted || !identity) return;
        onCompleteRef.current(relationship);
      })
      .catch((cause) => {
        if (!mounted) return;
        setError(toUserMessage(cause));
      });

    return () => {
      mounted = false;
    };
  }, [mode, pending, relationship]);

  const start = async () => {
    setError(null);
    setPairingProgress(0);
    setMode('create');
    try {
      const next = await cloudRuntime.startPairingInvitation(15 * 60, (progress) => {
        setPairingProgress(progress);
      });
      setPending(next);
      setPairingProgress(null);
    } catch (cause) {
      setPairingProgress(null);
      setMode('choice');
      setError(toUserMessage(cause));
    }
  };

  const cancel = async () => {
    await cloudRuntime.cancelPendingPairing();
    setPending(null);
    setPairingProgress(null);
    setError(null);
    setMode('choice');
  };

  const acceptManual = async (value: string) => {
    if (!isValidPairingConfirmationCode(value)) return;

    setError(null);
    setPairingProgress(0);
    setMode('joining');
    try {
      await cloudRuntime.acceptPairingInput({ transport: 'EMOJI', value }, (progress) => {
        setPairingProgress(progress);
      });
      setPairingProgress(null);
      onCompleteRef.current(relationship);
    } catch (cause) {
      setPairingProgress(null);
      setError(toUserMessage(cause));
      setMode('choice');
    }
  };

  if (mode === 'loading') return <PairingLoading progress={pairingProgress} />;
  if (mode === 'joining') return <JoiningPairing error={error} progress={pairingProgress} />;
  if (mode === 'create' && pending) {
    return (
      <CreatePairing
        pending={pending}
        error={error}
        onShare={() => void sharePairingLink(pending)}
        onCancel={() => void cancel()}
      />
    );
  }
  if (mode === 'create') return <PairingLoading progress={pairingProgress} />;
  if (mode === 'join') {
    return (
      <JoinPairing
        error={error}
        onBack={() => { setError(null); setMode('choice'); }}
        onComplete={(value) => void acceptManual(value)}
      />
    );
  }

  return (
    <ChoiceScreen
      relationship={relationship}
      error={error}
      onCreate={() => void start()}
      onJoin={() => { setError(null); setMode('join'); }}
      onContinue={() => onCompleteRef.current(relationship)}
      onBack={onBack}
    />
  );
}

function PairingLoading({ progress }: { progress: number | null }) {
  return (
    <View style={styles.container}>
      <Text style={styles.logo}>rucola</Text>
      <Text style={styles.heading}>getting things ready...</Text>
      {progress !== null ? (
        <Text style={styles.progress}>secure setup {Math.round(progress * 100)}%</Text>
      ) : null}
    </View>
  );
}

function JoiningPairing({
  error,
  progress,
}: {
  error: string | null;
  progress: number | null;
}) {
  return (
    <View style={styles.container}>
      <Text style={styles.logo}>rucola</Text>
      <Text style={styles.heading}>connecting you two...</Text>
      <Text style={styles.body}>
        rucola is doing the secure connection in the background. You can leave this screen open.
      </Text>
      {progress !== null ? (
        <Text style={styles.progress}>secure setup {Math.round(progress * 100)}%</Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function ChoiceScreen({
  relationship,
  error,
  onCreate,
  onJoin,
  onContinue,
  onBack,
}: {
  relationship: Relationship;
  error: string | null;
  onCreate: () => void;
  onJoin: () => void;
  onContinue: () => void;
  onBack?: () => void;
}) {
  return (
    <View style={styles.container}>
      <Text style={styles.logo}>rucola</Text>
      <Text style={styles.heading}>connect with {relationship.partnerNickname}</Text>
      <Text style={styles.body}>
        pair the two phones so you can leave things for each other over the internet.
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <ActionButton label="create pairing" onPress={onCreate} />
      <ActionButton label="join pairing" onPress={onJoin} secondary />
      {onBack ? <Text style={styles.link} onPress={onBack}>‹ back</Text> : null}
      <Text style={styles.or}>or</Text>
      <Text style={styles.offlineLink} onPress={onContinue}>keep using it on this phone</Text>
    </View>
  );
}

function CreatePairing({
  pending,
  error,
  onShare,
  onCancel,
}: {
  pending: PairingInvitationView;
  error: string | null;
  onShare: () => void;
  onCancel: () => void;
}) {
  const remaining = useRemainingTime(pending.expiresAt);

  return (
    <View style={styles.container}>
      <Text style={styles.logo}>rucola</Text>
      <Text style={styles.heading}>show this to your person</Text>
      <Text style={styles.emojiCode}>{pending.pairingCode}</Text>
      <Text style={styles.body}>
        They can enter these five emojis, or you can send them the link.
      </Text>
      <ActionButton label="share link" onPress={onShare} />
      <Text style={styles.waiting}>waiting for them... {formatRemaining(remaining)}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Text style={styles.link} onPress={onCancel}>cancel pairing</Text>
    </View>
  );
}

function JoinPairing({
  error,
  onBack,
  onComplete,
}: {
  error: string | null;
  onBack: () => void;
  onComplete: (value: string) => void;
}) {
  const [confirmationCode, setConfirmationCode] = useState('');
  const validCode = isValidPairingConfirmationCode(confirmationCode);

  return (
    <View style={styles.container}>
      <Text style={styles.logo}>rucola</Text>
      <Text style={styles.heading}>connect to your person</Text>
      <Text style={styles.body}>
        Enter the five emojis they see on their phone.
      </Text>

      <Text style={styles.label}>five emojis</Text>
      <TextInput
        value={confirmationCode}
        onChangeText={(value) => setConfirmationCode(value.replace(/\s+/g, ''))}
        placeholder="😀😃😄😁😆"
        autoCorrect={false}
        maxLength={10}
        autoFocus
        style={[styles.input, styles.emojiInput]}
      />

      {!confirmationCode.trim() || validCode
        ? null
        : <Text style={styles.error}>Use exactly five of the pairing emojis.</Text>}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <ActionButton
        label="connect them"
        onPress={() => onComplete(confirmationCode)}
        disabled={!validCode}
      />
      <Text style={styles.link} onPress={onBack}>‹ back</Text>
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  secondary = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondaryButton,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
      accessible
      accessibilityRole="button"
      accessibilityState={{ disabled }}
    >
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>
        {label}
      </Text>
    </Pressable>
  );
}

function sharePairingLink(pending: PairingInvitationView) {
  void Share.share({
    title: 'Pair with me on Rucola',
    message: pending.shareUrl,
  }).catch(() => {
    // Share cancellation is expected. Never log or persist the pairing link.
  });
}

function useRemainingTime(expiresAt: number) {
  const [remaining, setRemaining] = useState(() => Math.max(0, expiresAt - Date.now()));

  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining(Math.max(0, expiresAt - Date.now()));
    }, 1000);
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
  const code = cause && typeof cause === 'object' && 'code' in cause
    ? String((cause as { code?: unknown }).code)
    : '';
  if (code === 'PAIRING_RATE_LIMITED') return 'Too many tries. Please wait and try again.';
  if (
    code === 'INVALID_INVITATION' ||
    code === 'INVITATION_CONSUMED' ||
    code === 'PAIRING_CLOSED'
  ) {
    return 'That pairing link or emoji code is no longer valid.';
  }
  if (
    code === 'CLIENT_NETWORK_ERROR' ||
    code === 'CLIENT_TIMEOUT'
  ) {
    return 'Rucola could not reach the service. Check your connection and try again.';
  }
  if (
    code === 'PAIRING_CONFLICT' ||
    code === 'INVALID_PAIRING_SESSION' ||
    code === 'PAIRING_NOT_READY'
  ) {
    return 'The two phones could not finish pairing. Start a new pairing and try again.';
  }
  return cause instanceof Error ? cause.message : 'Pairing could not be completed.';
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F6E9',
    padding: 28,
    justifyContent: 'center',
  },
  logo: {
    fontSize: 42,
    fontWeight: '800',
    alignSelf: 'center',
    marginBottom: 44,
  },
  heading: {
    fontSize: 30,
    fontWeight: '800',
    lineHeight: 36,
    marginBottom: 16,
  },
  body: {
    fontSize: 17,
    lineHeight: 25,
    opacity: 0.72,
    marginBottom: 24,
  },
  emojiCode: {
    fontSize: 40,
    letterSpacing: 4,
    marginBottom: 24,
  },
  progress: {
    marginTop: 4,
    fontSize: 15,
    fontWeight: '700',
    opacity: 0.6,
  },
  waiting: {
    marginTop: 24,
    fontSize: 17,
    fontWeight: '700',
    opacity: 0.75,
  },
  label: {
    fontSize: 14,
    fontWeight: '700',
    marginTop: 10,
    marginBottom: 8,
    opacity: 0.6,
  },
  input: {
    borderWidth: 1,
    borderColor: '#A9B7A2',
    borderRadius: 14,
    backgroundColor: '#FCFDF7',
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  emojiInput: {
    fontSize: 22,
    letterSpacing: 2,
  },
  button: {
    alignSelf: 'stretch',
    marginTop: 14,
    borderRadius: 18,
    backgroundColor: '#1D2A1B',
    paddingHorizontal: 22,
    paddingVertical: 15,
  },
  buttonText: {
    color: '#F3F6E9',
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '800',
  },
  secondaryButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#1D2A1B',
  },
  secondaryButtonText: {
    color: '#1D2A1B',
  },
  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.75 },
  error: {
    marginTop: 10,
    color: '#9B2C2C',
    lineHeight: 20,
  },
  or: {
    textAlign: 'center',
    marginVertical: 16,
    opacity: 0.55,
  },
  link: {
    marginTop: 22,
    textDecorationLine: 'underline',
    fontSize: 17,
  },
  offlineLink: {
    textAlign: 'center',
    textDecorationLine: 'underline',
    fontSize: 17,
  },
});
