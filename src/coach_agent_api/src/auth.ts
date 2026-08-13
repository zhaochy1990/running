import { importSPKI, jwtVerify } from "jose";

export interface JwtVerifier {
	verify(authorization: string | undefined): Promise<{ userId: string }>;
}

export class AuthError extends Error {}

export async function createJwtVerifier(options: {
	publicKeyPem: string;
	issuer: string;
	audience?: string;
}): Promise<JwtVerifier> {
	const publicKey = await importSPKI(options.publicKeyPem, "RS256");
	return {
		async verify(authorization) {
			const token = bearerToken(authorization);
			try {
				const { payload } = await jwtVerify(token, publicKey, {
					algorithms: ["RS256"],
					issuer: options.issuer,
					...(options.audience ? { audience: options.audience } : {}),
				});
				if (typeof payload.sub !== "string" || payload.sub.length === 0) {
					throw new AuthError("token is missing sub");
				}
				return { userId: payload.sub };
			} catch (error) {
				if (error instanceof AuthError) throw error;
				throw new AuthError("invalid bearer token");
			}
		},
	};
}

function bearerToken(authorization: string | undefined): string {
	if (!authorization?.toLowerCase().startsWith("bearer ")) {
		throw new AuthError("missing bearer token");
	}
	const token = authorization.slice(7).trim();
	if (!token) throw new AuthError("missing bearer token");
	return token;
}
