import { z } from "zod";

export const loginRequestSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const changePasswordRequestSchema = z.object({
  current_password: z.string().min(1).max(128),
  new_password: z.string().min(8).max(128),
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export interface UserResponse {
  username: string;
}
