import { supabase } from '../config/supabase.js';
import { AppError } from '../utils/AppError.js';

const TABLE = 'users';
const COLUMNS = 'id, tz, phone, first_name, last_name';

// Maps Supabase / PostgREST / Postgres errors to AppError
const toAppError = (error) => {
  switch (error.code) {
    case 'PGRST116': // .single() returned 0 rows
      return new AppError('User not found', 404);
    case '23505': // unique_violation
      return new AppError('User already exists (duplicate value)', 409, error.details);
    case '22P02': // invalid_text_representation (e.g. bad uuid)
    case '22001': // string_data_right_truncation (value too long for column)
    case '23502': // not_null_violation
    case '23514': // check_violation
      return new AppError(error.message, 400);
    case '42501': // insufficient_privilege (usually RLS)
      return new AppError('Permission denied by database policy', 403);
    default:
      return new AppError(error.message || 'Database error', 500);
  }
};

export const getAllUsers = async () => {
  const { data, error } = await supabase.from(TABLE).select(COLUMNS);
  if (error) throw toAppError(error);
  return data;
};

export const getUserById = async (id) => {
  const { data, error } = await supabase.from(TABLE).select(COLUMNS).eq('id', id).single();
  if (error) throw toAppError(error);
  return data;
};

export const createUser = async (userData) => {
  const { data, error } = await supabase.from(TABLE).insert(userData).select(COLUMNS).single();
  if (error) throw toAppError(error);
  return data;
};

export const updateUser = async (id, updates) => {
  const { data, error } = await supabase
    .from(TABLE)
    .update(updates)
    .eq('id', id)
    .select(COLUMNS)
    .single();
  if (error) throw toAppError(error);
  return data;
};

export const deleteUser = async (id) => {
  // .select() returns deleted rows so we can detect "not found"
  const { data, error } = await supabase.from(TABLE).delete().eq('id', id).select('id');
  if (error) throw toAppError(error);
  if (!data || data.length === 0) throw new AppError('User not found', 404);
};
