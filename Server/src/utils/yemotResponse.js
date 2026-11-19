// Builders for Yemot HaMashiach "type=api" response commands.
// All knowledge of the response syntax lives here, so it is easy to fix in one place.
//
// Verified against the official "מודול API" docs (https://f2.freeivr.co.il/topic/56, posts 78283, 77476):
//   - Response is plain text. Commands are joined with "&".
//   - Message parts are joined with "." (e.g. "t-first.t-second").
//   - TTS text must not contain "." or "-".
//   - read=<prompt>=<var>,<reuse existing>,<max>,<min>,<timeout sec>,<playback type>,<block *>,<block 0>,...
//   - Digit input is the default read type (no "tap" keyword).
//   - Nothing can be chained after read ("&" after read is ignored), so extra messages go into the prompt.
// To verify against the docs / a live call (not shown verbatim in the docs):
//   - "id_list_message=...&go_to_folder=hangup" (each part is documented, the combination is not).
//   - Playback type spelling "No" (docs list it as "NO"/"No" in different places).
//   - An empty body as the answer to a hangup notification.
import { sanitizeText, sendYemot } from './yemot.js';

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const yesNo = (value) => (value ? 'yes' : 'no');

// Message part that reads a number digit by digit (docs: "d-" type)
export const digits = (value) => {
  const text = String(value ?? '');
  if (!/^\d+$/.test(text)) throw new Error('digits() accepts digits only');
  return { part: `d-${text}` };
};

// Builds message parts. Strings become TTS ("t-"), digits() objects are kept as is.
// ['a', digits('12'), 'b'] -> "t-a.d-12.t-b"
export const messageParts = (items) =>
  []
    .concat(items)
    .map((item) => (typeof item === 'object' && item?.part ? item.part : sanitizeText(item)))
    .filter(Boolean)
    .map((part) => (/^d-\d+$/.test(part) ? part : `t-${part}`))
    .join('.');

// Kept for readability where only text is played
export const ttsParts = messageParts;

/**
 * read command for keypad (digits) input. The caller ends input with "#"
 * (or input ends automatically when maxDigits is reached).
 * prompt: array of sentences and/or digits() parts played before collecting digits.
 * allowedDigits: optional list of accepted values, e.g. ['1', '2'].
 */
export const readDigits = ({
  prompt,
  varName,
  maxDigits,
  minDigits = 1,
  timeoutSec = 7,
  playbackType = 'No', // no read-back / confirmation
  blockAsterisk = true,
  blockZero = false,
  reuseExisting = false, // false = always ask again, even if the var was already collected
  allowedDigits,
}) => {
  if (!VAR_NAME.test(varName)) throw new Error(`Invalid Yemot variable name: ${varName}`);

  const options = [
    varName,
    yesNo(reuseExisting),
    maxDigits ?? '',
    minDigits,
    timeoutSec,
    playbackType,
    yesNo(blockAsterisk),
    yesNo(blockZero),
  ];
  if (allowedDigits?.length) {
    if (!allowedDigits.every((d) => /^\d+$/.test(d))) throw new Error('allowedDigits: digits only');
    // 9th option: replace char (unused), 10th: allowed values joined with "."
    options.push('', allowedDigits.join('.'));
  }
  return `read=${messageParts(prompt)}=${options.join(',')}`;
};

// Play a message, then hang up
export const messageAndHangup = (sentences) =>
  `id_list_message=${ttsParts(sentences)}&go_to_folder=hangup`;

// Answer for requests that need no action (e.g. hangup notification)
export const emptyResponse = () => '';

// Send with text/plain; charset=utf-8
export const sendYemotResponse = sendYemot;
