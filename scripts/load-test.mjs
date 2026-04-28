const DEFAULTS = {
  baseUrl: process.env.LOAD_TEST_BASE_URL || "http://localhost:3001",
  target: "catalog",
  requests: 30,
  concurrency: 5,
  timeoutMs: 15000,
};

const HELP_TEXT = `
Uso:
  npm run load:test -- --base-url=https://backend-de-suena.onrender.com --target=catalog

Opciones:
  --base-url=URL         URL base del backend. Default: ${DEFAULTS.baseUrl}
  --target=TIPO          catalog | mercadopago | orders
  --requests=NUM         Cantidad total de requests. Default: ${DEFAULTS.requests}
  --concurrency=NUM      Requests simultaneos. Default: ${DEFAULTS.concurrency}
  --timeout-ms=NUM       Timeout por request. Default: ${DEFAULTS.timeoutMs}
  --allow-write          Requerido para probar /pedidos porque descuenta stock real
  --help                 Muestra esta ayuda

Ejemplos:
  npm run load:test -- --base-url=http://localhost:3001 --target=catalog --requests=100 --concurrency=10
  npm run load:test -- --base-url=https://backend-de-suena.onrender.com --target=mercadopago --requests=20 --concurrency=4
  npm run load:test -- --base-url=http://localhost:3001 --target=orders --requests=10 --concurrency=2 --allow-write
`.trim();

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    ...DEFAULTS,
    allowWrite: false,
  };

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--allow-write") {
      options.allowWrite = true;
      continue;
    }

    const [rawKey, ...rawValueParts] = arg.split("=");
    const rawValue = rawValueParts.join("=");

    if (!rawKey.startsWith("--") || !rawValue) {
      throw new Error(`Argumento invalido: ${arg}`);
    }

    const key = rawKey.slice(2);

    if (key === "base-url") {
      options.baseUrl = rawValue.replace(/\/$/, "");
    } else if (key === "target") {
      options.target = rawValue;
    } else if (key === "requests") {
      options.requests = Number.parseInt(rawValue, 10);
    } else if (key === "concurrency") {
      options.concurrency = Number.parseInt(rawValue, 10);
    } else if (key === "timeout-ms") {
      options.timeoutMs = Number.parseInt(rawValue, 10);
    } else {
      throw new Error(`Opcion no reconocida: ${rawKey}`);
    }
  }

  if (!["catalog", "mercadopago", "orders"].includes(options.target)) {
    throw new Error(`Target invalido: ${options.target}`);
  }

  if (!Number.isInteger(options.requests) || options.requests <= 0) {
    throw new Error("La cantidad de requests debe ser un entero mayor a 0.");
  }

  if (!Number.isInteger(options.concurrency) || options.concurrency <= 0) {
    throw new Error("La concurrencia debe ser un entero mayor a 0.");
  }

  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("El timeout debe ser un entero mayor a 0.");
  }

  if (options.target === "orders" && !options.allowWrite) {
    throw new Error(
      "Para probar /pedidos debes pasar --allow-write porque esta prueba descuenta stock real."
    );
  }

  return options;
};

const now = () => performance.now();

const average = (values) => {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((acc, value) => acc + value, 0) / values.length;
};

const percentile = (values, percent) => {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((first, second) => first - second);
  const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1);
  return sorted[index];
};

const fetchJson = async (url, options, timeoutMs) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers || {}),
      },
    });
    const text = await response.text();
    let body = null;

    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    return {
      ok: response.ok,
      status: response.status,
      body,
    };
  } finally {
    clearTimeout(timeout);
  }
};

const buildOrderPayload = async (baseUrl, timeoutMs, iteration) => {
  const productsResponse = await fetchJson(`${baseUrl}/productos`, { method: "GET" }, timeoutMs);

  if (!productsResponse.ok || !Array.isArray(productsResponse.body)) {
    throw new Error("No se pudo obtener productos para preparar la prueba.");
  }

  const availableProducts = productsResponse.body.filter((product) => Number(product.stock || 0) > 0);

  if (availableProducts.length === 0) {
    throw new Error("No hay productos con stock para probar pedidos.");
  }

  const selectedProducts = availableProducts.slice(0, Math.min(2, availableProducts.length));

  return {
    customerName: `Carga Test ${iteration + 1}`,
    customerPhone: "1149453115",
    address: "Test 123",
    deliveryMethod: "retiro",
    notes: "Pedido generado por script de carga",
    items: selectedProducts.map((product) => ({
      id: product.id,
      quantity: 1,
    })),
  };
};

const runSingleRequest = async (options, iteration) => {
  const startedAt = now();

  try {
    if (options.target === "catalog") {
      const response = await fetchJson(`${options.baseUrl}/productos`, { method: "GET" }, options.timeoutMs);

      return {
        durationMs: now() - startedAt,
        ok: response.ok,
        status: response.status,
        message: response.ok ? "Catalogo OK" : JSON.stringify(response.body),
      };
    }

    const payload = await buildOrderPayload(options.baseUrl, options.timeoutMs, iteration);

    if (options.target === "mercadopago") {
      const response = await fetchJson(
        `${options.baseUrl}/pagos/mercado-pago/preferencia`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
        options.timeoutMs
      );

      return {
        durationMs: now() - startedAt,
        ok: response.ok,
        status: response.status,
        message: response.ok
          ? `Preferencia ${response.body?.preferenceId || "creada"}`
          : JSON.stringify(response.body),
      };
    }

    const response = await fetchJson(
      `${options.baseUrl}/pedidos`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      options.timeoutMs
    );

    return {
      durationMs: now() - startedAt,
      ok: response.ok,
      status: response.status,
      message: response.ok ? `Pedido ${response.body?.orderId || "creado"}` : JSON.stringify(response.body),
    };
  } catch (error) {
    return {
      durationMs: now() - startedAt,
      ok: false,
      status: 0,
      message: error.name === "AbortError" ? "Timeout" : error.message,
    };
  }
};

const runLoadTest = async (options) => {
  const results = [];
  let nextIteration = 0;

  const worker = async () => {
    while (nextIteration < options.requests) {
      const currentIteration = nextIteration;
      nextIteration += 1;
      const result = await runSingleRequest(options, currentIteration);
      results.push(result);
      process.stdout.write(
        `[${currentIteration + 1}/${options.requests}] status=${result.status || "ERR"} ${result.durationMs.toFixed(0)}ms\n`
      );
    }
  };

  const startedAt = now();
  const workers = Array.from({ length: Math.min(options.concurrency, options.requests) }, () => worker());
  await Promise.all(workers);
  const totalDurationMs = now() - startedAt;

  return {
    results,
    totalDurationMs,
  };
};

const printSummary = ({ results, totalDurationMs }, options) => {
  const durations = results.map((result) => result.durationMs);
  const successCount = results.filter((result) => result.ok).length;
  const failureCount = results.length - successCount;
  const requestsPerSecond = results.length / (totalDurationMs / 1000);
  const groupedStatuses = results.reduce((acc, result) => {
    const key = String(result.status || "ERR");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  console.log("");
  console.log("Resumen");
  console.log("-------");
  console.log(`Target: ${options.target}`);
  console.log(`Base URL: ${options.baseUrl}`);
  console.log(`Requests: ${results.length}`);
  console.log(`Concurrencia: ${options.concurrency}`);
  console.log(`Tiempo total: ${totalDurationMs.toFixed(0)} ms`);
  console.log(`RPS aproximado: ${requestsPerSecond.toFixed(2)}`);
  console.log(`Exitos: ${successCount}`);
  console.log(`Fallos: ${failureCount}`);
  console.log(`Promedio: ${average(durations).toFixed(0)} ms`);
  console.log(`P95: ${percentile(durations, 95).toFixed(0)} ms`);
  console.log(`Maximo: ${Math.max(...durations).toFixed(0)} ms`);
  console.log(`Estados: ${Object.entries(groupedStatuses).map(([status, count]) => `${status}=${count}`).join(", ")}`);

  if (failureCount > 0) {
    console.log("");
    console.log("Primeros errores");
    console.log("----------------");
    results
      .filter((result) => !result.ok)
      .slice(0, 5)
      .forEach((result, index) => {
        console.log(`${index + 1}. status=${result.status || "ERR"} mensaje=${result.message}`);
      });
  }
};

const main = async () => {
  try {
    const options = parseArgs();

    if (options.help) {
      console.log(HELP_TEXT);
      return;
    }

    console.log(`Iniciando prueba "${options.target}" sobre ${options.baseUrl}`);
    if (options.target === "orders") {
      console.log("Atencion: esta prueba crea pedidos reales y descuenta stock.");
    }

    const summary = await runLoadTest(options);
    printSummary(summary, options);
  } catch (error) {
    console.error(error.message);
    console.error("");
    console.error(HELP_TEXT);
    process.exitCode = 1;
  }
};

await main();
