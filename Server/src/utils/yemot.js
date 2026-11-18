// Helpers for building responses in the Yemot HaMashiach "type=api" text format.
// A response is plain text: one or more commands joined with "&",
// e.g. "id_list_message=t-שלום וברוכים הבאים".

// Characters with special meaning in the Yemot response syntax:
//   .  separates message parts inside id_list_message
//   -  separates the type prefix (t-, f-, d-...) from the value
//   ,  separates read= parameters
//   &  separates commands
//   =  separates command name from value
//   " ' could break parsing
const FORBIDDEN_CHARS = /[.,\-&="'\r\n]/g;

// Make free text safe for TTS ("t-") playback
export const sanitizeText = (text) =>
  String(text ?? '')
    .replace(FORBIDDEN_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Text-to-speech message part
export const tts = (text) => `t-${sanitizeText(text)}`;

// id_list_message command; accepts one or more parts (e.g. tts('...'))
export const idListMessage = (...parts) => `id_list_message=${parts.join('.')}`;

// Join several commands into one response body
export const buildResponse = (...commands) => commands.filter(Boolean).join('&');

// Send a Yemot response with the correct content type and UTF-8 encoding
export const sendYemot = (res, body) => {
  res.status(200).type('text/plain; charset=utf-8').send(body);
};

// Extract the standard Api* parameters Yemot sends with each request
export const extractCallParams = (params = {}) => ({
  callId: params.ApiCallId,
  phone: params.ApiPhone,
  did: params.ApiDID,
  realDid: params.ApiRealDID,
  extension: params.ApiExtension,
  time: params.ApiTime,
  hangup: params.hangup === 'yes',
});
