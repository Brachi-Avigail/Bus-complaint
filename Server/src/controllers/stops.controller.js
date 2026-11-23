import * as stopsService from '../services/stops.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// Controllers handle req/res only; all data logic lives in the service layer

export const getByCode = asyncHandler(async (req, res) => {
  const stopCode = req.params.code;
  const stopName = await stopsService.getStopNameByCode(stopCode);
  res.status(200).json({ success: true, data: { stop_code: stopCode, stop_name: stopName } });
});
