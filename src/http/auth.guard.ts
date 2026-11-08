import { CanActivate, Injectable } from '@nestjs/common';

/**
 * PONTO DE EXTENSÃO de autenticação. Hoje é um no-op de propósito: o desafio permite não
 * implementar auth (decisão e desenho alternativo em ARCHITECTURE.md, seção "Autenticação").
 *
 * Quando houver IdP externo (OIDC), é aqui que o token é validado (assinatura via JWKS, `iss`,
 * `aud`, `exp`) e o `providerId` do token é comparado com o `providerId` do corpo, para um
 * provedor não operar em nome de outro. NUNCA guardar senha em tabela própria.
 * Os endpoints /health/* e /metrics continuam abertos (marcar com um decorator @Public()).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
