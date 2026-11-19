// All IVR voice prompts (Hebrew TTS) in one place.
// Each message is an array of sentences. Every sentence becomes a separate "t-" part,
// so do not use "." or "-" inside a sentence (Yemot treats them as separators).
// Write numbers as words ("אחת", not "1") so the TTS reads them naturally.
export const ivrMessages = Object.freeze({
  welcome: ['שלום וברוכים הבאים למערכת תלונות אוטובוסים'],
  enterId: ['נא הקש מספר תעודת זהות ולסיום הקש סולמית'],
  reenterId: ['הקש שוב תעודת זהות ולסיום הקש סולמית'],
  invalidId: ['מספר תעודת הזהות שהוקש אינו תקין', 'נא נסה שוב'],
  // Played around the keyed ID: "<confirmPrefix> 0 3 9 ... <confirmOptions>"
  confirmPrefix: ['מספר תעודת הזהות שהוקש הינו'],
  confirmOptions: ['לאישור הקש אחת', 'לשינוי הקש שתיים'],
  idReceived: ['תודה', 'מספר תעודת הזהות שלך התקבל'],
  tooManyAttempts: ['מספר הניסיונות הסתיים', 'תודה שפנית אלינו ולהתראות'],
  error: ['אירעה שגיאה במערכת', 'נא נסה שוב מאוחר יותר'],
});
