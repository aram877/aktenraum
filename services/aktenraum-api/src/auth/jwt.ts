import jwt from "jsonwebtoken";

const ALG = "HS256";

export function createToken(
  userId: number,
  options: { secret: string; expiresSeconds: number },
): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: String(userId),
      iat: now,
      exp: now + options.expiresSeconds,
    },
    options.secret,
    { algorithm: ALG },
  );
}

export function verifyToken(token: string, options: { secret: string }): number | null {
  let payload: jwt.JwtPayload | string;
  try {
    payload = jwt.verify(token, options.secret, { algorithms: [ALG] });
  } catch {
    return null;
  }
  if (typeof payload === "string") return null;
  const sub = payload.sub;
  if (typeof sub !== "string" || !/^\d+$/.test(sub)) return null;
  return Number(sub);
}
