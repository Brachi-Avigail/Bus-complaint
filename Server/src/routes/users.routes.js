import { Router } from 'express';
import * as usersController from '../controllers/users.controller.js';
import { validate } from '../middlewares/validate.js';
import {
  createUserSchema,
  updateUserSchema,
  userIdParamsSchema,
} from '../schemas/user.schema.js';

const router = Router();

const validateId = validate(userIdParamsSchema, 'params');

router.get('/', usersController.getAll);
router.get('/:id', validateId, usersController.getById);
router.post('/', validate(createUserSchema), usersController.create);
router.put('/:id', validateId, validate(updateUserSchema), usersController.update);
router.delete('/:id', validateId, usersController.remove);

export default router;
