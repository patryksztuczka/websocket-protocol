export function sendHttpError(statusCode: number, message: string) {
  return `HTTP/1.1 ${statusCode} ${httpStatusText(statusCode)}\r\n\r\n${message}\r\n`;
}

export function httpStatusText(code: number) {
  const statusTexts: Record<number, string> = {
    400: "Bad Request",
    403: "Forbidden",
    405: "Method Not Allowed",
    426: "Upgrade Required",
  };

  return statusTexts[code] || "Error";
}
