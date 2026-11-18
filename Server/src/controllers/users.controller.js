import * as usersService from '../services/users.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// Controllers handle req/res only; all data logic lives in the service layer

export const getAll = asyncHandler(async (req, res) => {
  const users = await usersService.getAllUsers();
  res.status(200).json({ success: true, data: users });
});

export const getById = asyncHandler(async (req, res) => {
  const user = await usersService.getUserById(req.params.id);
  res.status(200).json({ success: true, data: user });
});

export const create = asyncHandler(async (req, res) => {
  const user = await usersService.createUser(req.body);
  res.status(201).json({ success: true, data: user });
});

export const update = asyncHandler(async (req, res) => {
  const user = await usersService.updateUser(req.params.id, req.body);
  res.status(200).json({ success: true, data: user });
});

export const remove = asyncHandler(async (req, res) => {
  await usersService.deleteUser(req.params.id);
  res.status(204).send();
});
