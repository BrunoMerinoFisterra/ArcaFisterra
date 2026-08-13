/**
 * Validacion de CUIT por digito verificador (modulo 11).
 *
 * Es la misma logica que el spike de `arca-worker`, y por buenos motivos:
 * un CUIT mal tipeado que llega al portal cuenta como intento fallido, y a los
 * pocos intentos ARCA bloquea la cuenta del contribuyente. Atajarlo en el alta
 * evita que ese dato malo llegue a existir.
 */

const PESOS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** null si es valido, o el motivo del rechazo. */
export function validarCuit(entrada: string): string | null {
  const cuit = entrada.replace(/\D/g, '');
  if (cuit.length !== 11) return `Tiene ${cuit.length} dígitos y debe tener 11.`;

  const suma = PESOS.reduce((acc, peso, i) => acc + peso * Number(cuit[i]), 0);
  const resto = suma % 11;
  const esperado = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;

  if (Number(cuit[10]) !== esperado) return 'El dígito verificador no es correcto.';
  return null;
}

/** 20123456789 -> 20-12345678-9 */
export function formatearCuit(entrada: string): string {
  const c = entrada.replace(/\D/g, '');
  if (c.length !== 11) return entrada;
  return `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}`;
}
