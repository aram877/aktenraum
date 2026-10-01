import jwt from "jsonwebtoken";

const ALG = "HS256";

export interface SessionClaims {
  userId: number;
  fingerprint: string;
}

export function createToken(
  userId: number,
  options: { secret: string; expiresSeconds: number; fingerprint: string },
): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: String(userId),
      pwf: options.fingerprint,
      iat: now,
      exp: now + options.expiresSeconds,
    },
    options.secret,
    { algorithm: ALG },
  );
}

export function verifyToken(token: string, options: { secret: string }): SessionClaims | null {
  let payload: jwt.JwtPayload | string;
  try {
    payload = jwt.verify(token, options.secret, { algorithms: [ALG] });
  } catch {
    return null;
  }
  if (typeof payload === "string") return null;
  const sub = payload.sub;
  const fingerprint: unknown = payload.pwf;
  if (typeof sub !== "string" || !/^\d+$/.test(sub)) return null;
  if (typeof fingerprint !== "string" || fingerprint === "") return null;
  return { userId: Number(sub), fingerprint };
}
