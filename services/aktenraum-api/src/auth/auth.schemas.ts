import { z } from "zod";

export const loginRequestSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export interface UserResponse {
  username: string;
  /** Present on `/auth/me`; the SPA shows household management only to `admin`. */
  household_role?: "admin" | "member";
  /** On `/auth/me`: the session may only enrol a passkey (auth-passkeys §4). */
  enrolment_required?: boolean;
  auth_method?: string;
  /** On `/auth/me` with a personal access token (`auth_method: "token"`). */
  token_name?: string;
}
