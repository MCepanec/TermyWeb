import bcrypt from 'bcryptjs';

// 12 rounds = ~300ms on modern hardware — good balance
const ROUNDS = 12;

export async function hashPassword(password) {
  if (!password || password.length < 8)
    throw new Error(
      'Password must be at least 8 characters');
  return bcrypt.hash(password, ROUNDS);
}

export async function verifyPassword(hash, password) {
  if (!password || !hash) return false;
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}