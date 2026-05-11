import bcrypt from 'bcryptjs';

const ROUNDS = 12;

export async function hashPassword(password) {
  return bcrypt.hash(password, ROUNDS);
}

export async function verifyPassword(password, hash) {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}