import { Router } from 'express';
import * as stopsController from '../controllers/stops.controller.js';
import { validate } from '../middlewares/validate.js';
import { stopCodeParamsSchema } from '../schemas/stop.schema.js';

const router = Router();

router.get('/:code', validate(stopCodeParamsSchema, 'params'), stopsController.getByCode);

export default router;
