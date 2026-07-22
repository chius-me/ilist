function removeOneLineEnding(value) {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  if (value.endsWith('\n') || value.endsWith('\r')) return value.slice(0, -1);
  return value;
}

async function readPipedPassword(input) {
  let value = '';
  input.setEncoding?.('utf8');
  for await (const chunk of input) value += chunk;
  const password = removeOneLineEnding(value);
  if (password.includes('\n') || password.includes('\r')) {
    throw new Error('Password input must contain exactly one line.');
  }
  return password;
}

export function readHiddenTtyPassword(input, errorOutput) {
  if (typeof input.setRawMode !== 'function') {
    throw new Error('This terminal cannot disable password echo.');
  }

  return new Promise((resolve, reject) => {
    const characters = [];
    let settled = false;
    let rawModeEnabled = false;

    const cleanup = () => {
      input.off('data', onData);
      input.off('error', onError);
      if (rawModeEnabled) {
        try {
          input.setRawMode(false);
        } catch {
          // The process is already leaving password-entry mode.
        }
        rawModeEnabled = false;
      }
      try {
        input.pause?.();
      } catch {
        // Terminal cleanup must not expose or replace the input result.
      }
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      errorOutput.write('\n');
      callback();
    };
    const onError = () => finish(() => reject(new Error('Unable to read password input.')));
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === '\r' || character === '\n') {
          finish(() => resolve(characters.join('')));
          return;
        }
        if (character === '\u0003') {
          finish(() => reject(new Error('Password input was cancelled.')));
          return;
        }
        if (character === '\u0008' || character === '\u007f') {
          characters.pop();
        } else if (character >= ' ') {
          characters.push(character);
        }
      }
    };

    errorOutput.write('Admin password: ');
    input.on('data', onData);
    input.on('error', onError);
    try {
      input.setEncoding?.('utf8');
      input.setRawMode(true);
      rawModeEnabled = true;
      input.resume?.();
    } catch {
      cleanup();
      reject(new Error('This terminal cannot disable password echo.'));
    }
  });
}

export function readPasswordInput(input, errorOutput) {
  return input.isTTY ? readHiddenTtyPassword(input, errorOutput) : readPipedPassword(input);
}
