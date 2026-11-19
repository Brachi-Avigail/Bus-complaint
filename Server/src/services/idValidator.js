// Israeli ID (teudat zehut) validation. Pure functions, no dependencies.

export const ID_LENGTH = 9;
export const ID_MIN_LENGTH = 5; // old IDs may be keyed without leading zeros

/**
 * Validates an Israeli ID.
 * Returns { valid: true, id } with the ID padded to 9 digits,
 * or { valid: false, reason }.
 */
export const validateIsraeliId = (raw) => {
  const input = String(raw ?? '').trim();

  if (!/^\d+$/.test(input)) return { valid: false, reason: 'not_digits' };
  if (input.length < ID_MIN_LENGTH || input.length > ID_LENGTH) {
    return { valid: false, reason: 'bad_length' };
  }

  const id = input.padStart(ID_LENGTH, '0');
  if (/^0+$/.test(id)) return { valid: false, reason: 'all_zeros' };

  // Check digit: multiply digits by 1,2,1,2..., sum the digits of each product
  let sum = 0;
  for (let i = 0; i < ID_LENGTH; i += 1) {
    const product = Number(id[i]) * ((i % 2) + 1);
    sum += product > 9 ? product - 9 : product;
  }
  if (sum % 10 !== 0) return { valid: false, reason: 'bad_check_digit' };

  return { valid: true, id };
};

export const isValidIsraeliId = (raw) => validateIsraeliId(raw).valid;

// "123456782" -> "******782"
export const maskId = (id) => {
  const value = String(id ?? '');
  if (value.length <= 3) return '*'.repeat(value.length);
  return '*'.repeat(value.length - 3) + value.slice(-3);
};
