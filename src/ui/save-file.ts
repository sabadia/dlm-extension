/** Offers `text` to the person as a file download (a page of the extension may do this with no permission). */
export function saveTextFile(name: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // The download has started by the time this runs; the address can go.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
