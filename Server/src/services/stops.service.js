import { supabase } from '../config/supabase.js';
import { AppError } from '../utils/AppError.js';

const TABLE = 'gtfs_stops';

/**
 * Returns the name of a stop by the number shown on the stop sign (GTFS stop_code).
 * A stop_code can appear on several rows (platforms of one terminal); they all
 * share the same name, so the first row is enough.
 * @param {number} stopCode
 * @returns {Promise<string>}
 * @throws {AppError} 404 if no stop has this code
 */
export const getStopNameByCode = async (stopCode) => {
  const { data, error } = await supabase
    .from(TABLE)
    .select('stop_name')
    .eq('stop_code', stopCode)
    .limit(1)
    .maybeSingle();

  if (error) throw new AppError(error.message || 'Database error', 500);
  if (!data) throw new AppError('Stop not found', 404);
  return data.stop_name;
};
