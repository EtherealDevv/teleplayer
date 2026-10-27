export function errorText(error: unknown): string {
  const raw =
    typeof error === 'object' && error !== null
      ? String((error as { errorMessage?: unknown; message?: unknown }).errorMessage ?? (error as Error).message ?? error)
      : String(error)
  const message = raw.replace(/^Error:\s*/i, '').trim()

  const flood = /FLOOD_WAIT_(\d+)/.exec(message)
  if (flood) {
    const seconds = Number(flood[1])
    if (seconds < 90) return `Telegram pidió esperar ${seconds} segundos. Inténtalo de nuevo en un momento.`
    return `Telegram pidió esperar ${Math.ceil(seconds / 60)} minutos. Inténtalo más tarde.`
  }
  if (message.includes('API_ID_INVALID') || message.includes('API_ID_PUBLISHED_FLOOD')) {
    return 'Las credenciales API no son válidas. Revisa el api_id y el api_hash en my.telegram.org.'
  }
  if (message.includes('PHONE_NUMBER_INVALID')) {
    return 'El número no es válido. Escríbelo con el prefijo internacional, por ejemplo +34 600 000 000.'
  }
  if (message.includes('PHONE_NUMBER_BANNED')) {
    return 'Telegram ha bloqueado este número.'
  }
  if (message.includes('PHONE_NUMBER_UNOCCUPIED')) {
    return 'Esa cuenta todavía no existe en Telegram. Crea la cuenta en la app oficial y vuelve a intentarlo.'
  }
  if (message.includes('PHONE_CODE_INVALID')) {
    return 'El código no es correcto. Revísalo y vuelve a intentarlo.'
  }
  if (message.includes('PHONE_CODE_EXPIRED')) {
    return 'El código caducó. Solicita uno nuevo.'
  }
  if (message.includes('PASSWORD_HASH_INVALID')) {
    return 'La contraseña de verificación en dos pasos no es correcta.'
  }
  if (message.includes('LOGIN_EMAIL_REQUIRED') || message.includes('EMAIL_VERIFICATION_REQUIRED')) {
    return 'Telegram pide configurar un correo de inicio de sesión. Completa esa verificación en la app oficial de Telegram y vuelve a intentarlo.'
  }
  if (message.includes('SESSION_PASSWORD_NEEDED')) {
    return 'Tu cuenta tiene verificación en dos pasos. Escribe la contraseña.'
  }
  if (
    message.includes('AUTH_KEY_UNREGISTERED') ||
    message.includes('SESSION_REVOKED') ||
    message.includes('USER_DEACTIVATED') ||
    message.includes('AUTH_KEY_DUPLICATED')
  ) {
    return 'La sesión de Telegram ya no es válida. Vuelve a iniciar sesión.'
  }
  if (message.includes('CHANNEL_INVALID') || message.includes('CHANNEL_PRIVATE')) {
    return 'No se pudo acceder al canal de TelePlayer. Puede que lo hayas eliminado o que la sesión haya cambiado de cuenta.'
  }
  if (message.includes('FILE_TOO_BIG')) {
    return 'Telegram rechazó una parte por tamaño. Actualiza TelePlayer para volver a dividirla.'
  }
  if (message.includes('FILE_PARTS_INVALID') || message.includes('FILE_PART_')) {
    return 'La subida se interrumpió y Telegram rechazó una parte. Vuelve a intentarlo.'
  }
  if (message.includes('MEDIA_EMPTY') || message.includes('MEDIA_INVALID')) {
    return 'Telegram no aceptó este archivo como vídeo.'
  }
  if (message.includes('DOWNLOAD_CANCELLED')) {
    return 'Descarga cancelada.'
  }
  if (message.includes('TIMEOUT') || message.includes('ECONNRESET') || message.includes('ENOTFOUND')) {
    return 'No hay conexión con Telegram. Revisa tu internet e inténtalo de nuevo.'
  }
  if (message.includes('ENOSPC')) {
    return 'No queda espacio en disco para guardar la caché.'
  }
  if (message.includes('API_NO_CREDENTIALS') || message.includes('NO_CREDENTIALS')) {
    return 'Primero configura tus credenciales API de Telegram.'
  }
  if (message.includes('NOT_AUTHORIZED')) {
    return 'Inicia sesión en Telegram para continuar.'
  }
  if (!message || message === '[object Object]') {
    return 'Ha ocurrido un error inesperado. Inténtalo de nuevo.'
  }
  return message
}
