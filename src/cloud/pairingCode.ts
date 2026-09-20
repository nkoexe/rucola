export const PAIRING_EMOJIS = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣',
  '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰',
  '😘', '😗', '😙', '😚', '😋', '😛', '😜', '🤪',
  '😎', '🤩', '🥳', '🤗', '🤔', '🥺', '😭', '😡',
  '😴',
] as const;

export function isValidPairingConfirmationCode(value: string): boolean {
  const emojis = Array.from(value);
  return emojis.length === 5 && emojis.every((emoji) => (PAIRING_EMOJIS as readonly string[]).includes(emoji));
}