// 合规声明服务层 —— 对接 stride-api 公开声明接口（无需登录）。
// 后端契约：`internal/api/legal_documents.go`（GET /api/declarations/:doc_type）。

import { http } from './request';

/** 小程序内开放的声明类型（后端共 5 种，这里按需求只开放两个）。 */
export type DeclarationDocType = 'user_agreement' | 'privacy_policy';

/** 声明类型的展示文案。 */
export const DECLARATION_TITLES: Record<DeclarationDocType, string> = {
  user_agreement: '用户协议',
  privacy_policy: '隐私政策',
};

/** 判断 docType 是否为本小程序开放阅读的声明类型。 */
export function isDeclarationDocType(value: string): value is DeclarationDocType {
  return value === 'user_agreement' || value === 'privacy_policy';
}

/** 公开声明（当前生效版本，含 Markdown 正文）。镜像 Go `publicDeclarationBody`。 */
export interface Declaration {
  doc_type: string;
  version: number;
  title: string;
  effective_at: string | null;
  updated_at: string;
  content_markdown: string;
}

/** 拉取某类型当前生效的声明正文。公开接口，未登录可读。 */
export function getDeclaration(docType: DeclarationDocType): Promise<Declaration> {
  return http.get<Declaration>(`/api/declarations/${docType}`, { auth: false });
}
