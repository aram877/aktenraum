import bcrypt from "bcryptjs";

const ROUNDS = 12;

/** password_hash of a member created without a password (never a bcrypt string). */
export const NO_PASSWORD = "!";

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hashed: string): Promise<boolean> {
  // Only bcrypt hashes are compared; "!" (no password) and anything else is false.
  if (!/^\$2[aby]\$\d{2}\$/.test(hashed)) return false;
  try {
    return await bcrypt.compare(plain, hashed);
  } catch {
    return false;
  }
}
