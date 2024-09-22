import { z } from "zod";
import { createAuthEndpoint } from "../../api/call";
import type { BetterAuthPlugin } from "../../types/plugins";
import type { User } from "../../adapters/schema";
import { APIError } from "better-call";
import { createEmailVerificationToken } from "../../api/routes";
import { logger } from "../../utils/logger";
import { validateJWT, type JWT } from "oslo/jwt";
import { setSessionCookie } from "../../utils/cookies";

interface MagicLinkOptions {
	/**
	 * Time in seconds until the magic link expires.
	 * @default (60 * 60) // 1 hour
	 */
	expiresIn?: number;
	/**
	 * Send magic link implementation.
	 */
	sendMagicLink: (email: string, url: string) => Promise<void> | void;
}

export const magicLink = (options: MagicLinkOptions) => {
	return {
		id: "magic-link",
		endpoints: {
			signInMagicLink: createAuthEndpoint(
				"/sign-in/magic-link",
				{
					method: "POST",
					requireHeaders: true,
					body: z.object({
						email: z.string().email(),
						callbackURL: z.string().optional(),
						currentURL: z.string().optional(),
					}),
				},
				async (ctx) => {
					const { email } = ctx.body;
					const user = await ctx.context.internalAdapter.findUserByEmail(email);
					if (!user) {
						throw new APIError("UNAUTHORIZED", {
							message: "User not found",
						});
					}
					const token = await createEmailVerificationToken(
						ctx.context.secret,
						email,
					);
					const url = `${
						ctx.context.baseURL
					}/magic-link/verify?token=${token}&callbackURL=${
						ctx.body.callbackURL || ctx.body.currentURL
					}`;
					try {
						await options.sendMagicLink(email, url);
					} catch (e) {
						ctx.context.logger.error("Failed to send magic link", e);
						throw new APIError("INTERNAL_SERVER_ERROR", {
							message: "Failed to send magic link",
						});
					}
					return ctx.json({
						status: true,
					});
				},
			),
			magicLinkVerify: createAuthEndpoint(
				"/magic-link/verify",
				{
					method: "GET",
					query: z.object({
						token: z.string(),
						callbackURL: z.string().optional(),
					}),
					requireHeaders: true,
				},
				async (ctx) => {
					const { token, callbackURL } = ctx.query;
					let jwt: JWT;
					try {
						jwt = await validateJWT(
							"HS256",
							Buffer.from(ctx.context.secret),
							token,
						);
					} catch (e) {
						ctx.context.logger.error("Failed to verify email", e);
						return ctx.json(null, {
							status: 400,
							statusText: "INVALID_TOKEN",
							body: {
								message: "Invalid token",
							},
						});
					}
					const schema = z.object({
						email: z.string().email(),
					});
					const parsed = schema.parse(jwt.payload);
					const user = await ctx.context.internalAdapter.findUserByEmail(
						parsed.email,
					);
					if (!user) {
						return ctx.json(null, {
							status: 400,
							statusText: "USER_NOT_FOUND",
							body: {
								message: "User not found",
							},
						});
					}
					const session = await ctx.context.internalAdapter.createSession(
						user.user.id,
						ctx.headers,
					);
					if (!session) {
						return ctx.json(null, {
							status: 400,
							statusText: "SESSION NOT CREATED",
							body: {
								message: "Failed to create session",
							},
						});
					}
					await setSessionCookie(ctx, session.id);
					if (!callbackURL) {
						return ctx.json({
							status: true,
						});
					}
					throw ctx.redirect(callbackURL);
				},
			),
		},
	} satisfies BetterAuthPlugin;
};