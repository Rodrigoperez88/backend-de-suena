import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { clerkClient, clerkMiddleware, getAuth } from "@clerk/express";
import prisma from "./prismaClient.js";

dotenv.config();

const app = express();
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://localhost:5176",
  "http://localhost:5177",
  "http://localhost:5178",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:5175",
  "http://127.0.0.1:5176",
  "http://127.0.0.1:5177",
  "http://127.0.0.1:5178",
];
const ENV_ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const CORS_ALLOWED_ORIGINS = [...new Set([...ALLOWED_ORIGINS, ...ENV_ALLOWED_ORIGINS])];
const CLERK_IS_CONFIGURED = Boolean(process.env.CLERK_SECRET_KEY && process.env.CLERK_PUBLISHABLE_KEY);
const ADMIN_EMAILS = (process.env.CLERK_ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);
const ORDER_STATUSES = [
  "pendiente",
  "confirmado",
  "en_preparacion",
  "enviado",
  "entregado",
  "cancelado",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || CORS_ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Origen no permitido por CORS"));
    },
    credentials: true,
  })
);

app.use(express.json());

const requireAdmin = async (req, res, next) => {
  try {
    if (!CLERK_IS_CONFIGURED) {
      return res.status(500).json({
        error: "Autenticacion admin no configurada",
      });
    }

    const auth = getAuth(req);

    if (!auth.isAuthenticated || !auth.userId) {
      return res.status(401).json({
        error: "No autenticado",
      });
    }

    if (ADMIN_EMAILS.length === 0) {
      return res.status(403).json({
        error: "No hay emails admin configurados",
      });
    }

    const user = await clerkClient.users.getUser(auth.userId);
    const userEmails = user.emailAddresses.map((email) => email.emailAddress.toLowerCase());
    const isAdmin = userEmails.some((email) => ADMIN_EMAILS.includes(email));

    if (!isAdmin) {
      return res.status(403).json({
        error: "Usuario sin permisos de administrador",
      });
    }

    return next();
  } catch (error) {
    console.error("Error al validar admin:", error);
    return res.status(401).json({
      error: "No se pudo validar la sesion admin",
    });
  }
};

const sanitizeText = (value) => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : null;
};

const parseNumber = (value) => {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : null;
};

const parseInteger = (value) => {
  const parsedValue = Number.parseInt(value, 10);
  return Number.isInteger(parsedValue) ? parsedValue : null;
};

const MERCADO_PAGO_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN?.trim() || "";
const MERCADO_PAGO_WEBHOOK_URL = process.env.MERCADO_PAGO_WEBHOOK_URL?.trim() || "";
const FRONTEND_BASE_URL = (process.env.FRONTEND_URL || ENV_ALLOWED_ORIGINS[0] || "").replace(/\/$/, "");

const sendValidationError = (res, details) => {
  return res.status(400).json({
    error: "Datos invalidos",
    details,
  });
};

const validateOrderPayload = async (body) => {
  const normalizedCustomerName = sanitizeText(body.customerName);
  const normalizedCustomerPhone = sanitizeText(body.customerPhone);
  const normalizedAddress = sanitizeText(body.address);
  const normalizedDeliveryMethod = sanitizeText(body.deliveryMethod);
  const normalizedNotes = sanitizeText(body.notes);
  const { errors: itemErrors, normalizedItems } = parseOrderItems(body.items);

  if (!normalizedCustomerName || !normalizedCustomerPhone || !normalizedDeliveryMethod) {
    return {
      errors: ["Faltan datos obligatorios del cliente"],
    };
  }

  if (!["retiro", "envio"].includes(normalizedDeliveryMethod)) {
    return {
      errors: ["El metodo de entrega es invalido"],
    };
  }

  if (normalizedDeliveryMethod === "envio" && !normalizedAddress) {
    return {
      errors: ["La direccion es obligatoria para envios"],
    };
  }

  if (itemErrors.length > 0) {
    return {
      errors: itemErrors,
    };
  }

  const productIds = normalizedItems.map((item) => item.id);
  const products = await prisma.product.findMany({
    where: {
      id: {
        in: productIds,
      },
    },
  });

  if (products.length !== normalizedItems.length) {
    return {
      errors: ["Uno o mas productos no existen"],
    };
  }

  for (const item of normalizedItems) {
    const product = products.find((candidate) => candidate.id === item.id);

    if (!product) {
      return {
        errors: [`Producto invalido: ${item.id}`],
      };
    }

    if (product.stock < item.quantity) {
      return {
        errors: [`Stock insuficiente para ${product.name}`],
      };
    }
  }

  const total = normalizedItems.reduce((acc, item) => {
    const product = products.find((candidate) => candidate.id === item.id);
    return acc + product.price * item.quantity;
  }, 0);

  return {
    errors: [],
    order: {
      customerName: normalizedCustomerName,
      customerPhone: normalizedCustomerPhone,
      address: normalizedAddress,
      deliveryMethod: normalizedDeliveryMethod,
      notes: normalizedNotes,
      items: normalizedItems,
      products,
      total,
    },
  };
};

const parseProductPayload = (body, { partial = false } = {}) => {
  const errors = [];
  const data = {};

  if ("name" in body || !partial) {
    const name = sanitizeText(body.name);

    if (!name) {
      errors.push("El nombre del producto es obligatorio");
    } else {
      data.name = name;
    }
  }

  if ("price" in body || !partial) {
    const price = parseNumber(body.price);

    if (price === null || price < 0) {
      errors.push("El precio debe ser un numero mayor o igual a 0");
    } else {
      data.price = price;
    }
  }

  if ("stock" in body || !partial) {
    const stock = parseInteger(body.stock);

    if (stock === null || stock < 0) {
      errors.push("El stock debe ser un entero mayor o igual a 0");
    } else {
      data.stock = stock;
    }
  }

  if ("description" in body) {
    data.description = sanitizeText(body.description);
  } else if (!partial) {
    data.description = null;
  }

  if ("image" in body) {
    data.image = sanitizeText(body.image);
  } else if (!partial) {
    data.image = null;
  }

  if ("category" in body) {
    data.category = sanitizeText(body.category);
  } else if (!partial) {
    data.category = null;
  }

  return { data, errors };
};

const parseCategoryPayload = (body, { partial = false } = {}) => {
  const errors = [];
  const data = {};

  if ("name" in body || !partial) {
    const name = sanitizeText(body.name);

    if (!name) {
      errors.push("El nombre de la categoria es obligatorio");
    } else {
      data.name = name;
    }
  }

  if ("image" in body) {
    data.image = sanitizeText(body.image);
  } else if (!partial) {
    data.image = null;
  }

  return { data, errors };
};

const getPublicSettings = async () => {
  const settings = await prisma.storeSetting.findMany({
    where: {
      key: {
        in: ["heroImage"],
      },
    },
  });

  return settings.reduce((acc, setting) => {
    acc[setting.key] = setting.value;
    return acc;
  }, {});
};

const parseOrderItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      errors: ["El pedido no tiene productos"],
      normalizedItems: [],
    };
  }

  const errors = [];
  const normalizedItems = items.map((item, index) => {
    const id = parseInteger(item.id);
    const quantity = parseInteger(item.quantity);

    if (id === null || id <= 0) {
      errors.push(`El item ${index + 1} tiene un producto invalido`);
    }

    if (quantity === null || quantity <= 0) {
      errors.push(`El item ${index + 1} tiene una cantidad invalida`);
    }

    return { id, quantity };
  });

  return { errors, normalizedItems };
};

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "API de Sueña en Grande funcionando",
  });
});

app.get("/productos", async (req, res) => {
  try {
    const productos = await prisma.product.findMany({
      orderBy: [
        { createdAt: "desc" },
        { id: "desc" },
      ],
    });

    res.json(productos);
  } catch (error) {
    console.error("Error al obtener productos:", error);
    res.status(500).json({
      error: "Error al obtener productos",
      detalle: error.message,
    });
  }
});

app.get("/categorias", async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: [
        { createdAt: "asc" },
        { id: "asc" },
      ],
    });

    res.json(categories);
  } catch (error) {
    console.error("Error al obtener categorias:", error);
    res.status(500).json({
      error: "Error al obtener categorias",
      detalle: error.message,
    });
  }
});

app.get("/configuracion", async (req, res) => {
  try {
    const settings = await getPublicSettings();

    res.json(settings);
  } catch (error) {
    console.error("Error al obtener configuracion:", error);
    res.status(500).json({
      error: "Error al obtener configuracion",
      detalle: error.message,
    });
  }
});

if (CLERK_IS_CONFIGURED) {
  app.use("/admin", clerkMiddleware(), requireAdmin);
} else {
  console.warn("CLERK_SECRET_KEY o CLERK_PUBLISHABLE_KEY no estan configuradas. Las rutas admin no estaran disponibles.");
  app.use("/admin", requireAdmin);
}

app.get("/admin/productos", async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      orderBy: [
        { createdAt: "desc" },
        { id: "desc" },
      ],
    });

    res.json(products);
  } catch (error) {
    console.error("Error al obtener productos para admin:", error);
    res.status(500).json({
      error: "Error al obtener productos",
      detalle: error.message,
    });
  }
});

app.get("/admin/configuracion", async (req, res) => {
  try {
    const settings = await getPublicSettings();

    res.json(settings);
  } catch (error) {
    console.error("Error al obtener configuracion admin:", error);
    res.status(500).json({
      error: "Error al obtener configuracion",
      detalle: error.message,
    });
  }
});

app.patch("/admin/configuracion", async (req, res) => {
  try {
    const heroImage = sanitizeText(req.body.heroImage);

    const setting = await prisma.storeSetting.upsert({
      where: {
        key: "heroImage",
      },
      update: {
        value: heroImage,
      },
      create: {
        key: "heroImage",
        value: heroImage,
      },
    });

    res.json({
      ok: true,
      message: "Configuracion actualizada correctamente",
      settings: {
        [setting.key]: setting.value,
      },
    });
  } catch (error) {
    console.error("Error al actualizar configuracion:", error);
    res.status(500).json({
      error: "Error al actualizar configuracion",
      detalle: error.message,
    });
  }
});

app.get("/admin/categorias", async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: [
        { createdAt: "asc" },
        { id: "asc" },
      ],
    });

    res.json(categories);
  } catch (error) {
    console.error("Error al obtener categorias para admin:", error);
    res.status(500).json({
      error: "Error al obtener categorias",
      detalle: error.message,
    });
  }
});

app.post("/admin/categorias", async (req, res) => {
  try {
    const { data, errors } = parseCategoryPayload(req.body);

    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const category = await prisma.category.create({ data });

    res.status(201).json({
      ok: true,
      message: "Categoria creada correctamente",
      category,
    });
  } catch (error) {
    console.error("Error al crear categoria:", error);

    if (error.code === "P2002") {
      return sendValidationError(res, ["Ya existe una categoria con ese nombre"]);
    }

    res.status(500).json({
      error: "Error al crear categoria",
      detalle: error.message,
    });
  }
});

app.patch("/admin/categorias/:id", async (req, res) => {
  try {
    const categoryId = parseInteger(req.params.id);

    if (categoryId === null || categoryId <= 0) {
      return sendValidationError(res, ["El id de la categoria es invalido"]);
    }

    const { data, errors } = parseCategoryPayload(req.body, { partial: true });

    if (Object.keys(data).length === 0) {
      errors.push("No hay campos para actualizar");
    }

    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const category = await prisma.category.update({
      where: { id: categoryId },
      data,
    });

    res.json({
      ok: true,
      message: "Categoria actualizada correctamente",
      category,
    });
  } catch (error) {
    console.error("Error al actualizar categoria:", error);

    if (error.code === "P2025") {
      return res.status(404).json({
        error: "Categoria no encontrada",
      });
    }

    if (error.code === "P2002") {
      return sendValidationError(res, ["Ya existe una categoria con ese nombre"]);
    }

    res.status(500).json({
      error: "Error al actualizar categoria",
      detalle: error.message,
    });
  }
});

app.delete("/admin/categorias/:id", async (req, res) => {
  try {
    const categoryId = parseInteger(req.params.id);

    if (categoryId === null || categoryId <= 0) {
      return sendValidationError(res, ["El id de la categoria es invalido"]);
    }

    const category = await prisma.category.findUnique({
      where: { id: categoryId },
    });

    if (!category) {
      return res.status(404).json({
        error: "Categoria no encontrada",
      });
    }

    const productsCount = await prisma.product.count({
      where: { category: category.name },
    });

    if (productsCount > 0) {
      return res.status(409).json({
        error: "No se puede eliminar una categoria con productos asociados",
      });
    }

    await prisma.category.delete({
      where: { id: categoryId },
    });

    res.json({
      ok: true,
      message: "Categoria eliminada correctamente",
    });
  } catch (error) {
    console.error("Error al eliminar categoria:", error);
    res.status(500).json({
      error: "Error al eliminar categoria",
      detalle: error.message,
    });
  }
});

app.post("/admin/productos", async (req, res) => {
  try {
    const { data, errors } = parseProductPayload(req.body);

    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const product = await prisma.product.create({ data });

    res.status(201).json({
      ok: true,
      message: "Producto creado correctamente",
      product,
    });
  } catch (error) {
    console.error("Error al crear producto:", error);
    res.status(500).json({
      error: "Error al crear producto",
      detalle: error.message,
    });
  }
});

app.patch("/admin/productos/:id", async (req, res) => {
  try {
    const productId = parseInteger(req.params.id);

    if (productId === null || productId <= 0) {
      return sendValidationError(res, ["El id del producto es invalido"]);
    }

    const { data, errors } = parseProductPayload(req.body, { partial: true });

    if (Object.keys(data).length === 0) {
      errors.push("No hay campos para actualizar");
    }

    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const product = await prisma.product.update({
      where: { id: productId },
      data,
    });

    res.json({
      ok: true,
      message: "Producto actualizado correctamente",
      product,
    });
  } catch (error) {
    console.error("Error al actualizar producto:", error);

    if (error.code === "P2025") {
      return res.status(404).json({
        error: "Producto no encontrado",
      });
    }

    res.status(500).json({
      error: "Error al actualizar producto",
      detalle: error.message,
    });
  }
});

app.delete("/admin/productos/:id", async (req, res) => {
  try {
    const productId = parseInteger(req.params.id);

    if (productId === null || productId <= 0) {
      return sendValidationError(res, ["El id del producto es invalido"]);
    }

    const orderItemsCount = await prisma.orderItem.count({
      where: { productId },
    });

    if (orderItemsCount > 0) {
      return res.status(409).json({
        error: "No se puede eliminar un producto con ventas asociadas",
      });
    }

    await prisma.product.delete({
      where: { id: productId },
    });

    res.json({
      ok: true,
      message: "Producto eliminado correctamente",
    });
  } catch (error) {
    console.error("Error al eliminar producto:", error);

    if (error.code === "P2025") {
      return res.status(404).json({
        error: "Producto no encontrado",
      });
    }

    res.status(500).json({
      error: "Error al eliminar producto",
      detalle: error.message,
    });
  }
});

app.post("/pedidos", async (req, res) => {
  try {
    const { errors, order } = await validateOrderPayload(req.body);

    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const pedidoCreado = await prisma.$transaction(async (tx) => {
      const nuevoPedido = await tx.order.create({
        data: {
          customerName: order.customerName,
          customerPhone: order.customerPhone,
          address: order.address,
          deliveryMethod: order.deliveryMethod,
          notes: order.notes,
          total: order.total,
          status: "pendiente",
        },
      });

      for (const item of order.items) {
        const productoDB = order.products.find((product) => product.id === item.id);

        await tx.orderItem.create({
          data: {
            orderId: nuevoPedido.id,
            productId: productoDB.id,
            productName: productoDB.name,
            unitPrice: productoDB.price,
            quantity: item.quantity,
            subtotal: productoDB.price * item.quantity,
          },
        });

        await tx.product.update({
          where: { id: productoDB.id },
          data: {
            stock: {
              decrement: item.quantity,
            },
          },
        });
      }

      return nuevoPedido;
    });

    res.status(201).json({
      ok: true,
      message: "Pedido creado correctamente",
      orderId: pedidoCreado.id,
    });
  } catch (error) {
    console.error("Error al crear pedido:", error);
    res.status(500).json({
      error: "Error al crear pedido",
      detalle: error.message,
    });
  }
});

app.post("/pagos/mercado-pago/preferencia", async (req, res) => {
  try {
    if (!MERCADO_PAGO_ACCESS_TOKEN) {
      return res.status(500).json({
        error: "Mercado Pago no configurado",
        detalle: "Falta MERCADO_PAGO_ACCESS_TOKEN en el backend.",
      });
    }

    if (!FRONTEND_BASE_URL) {
      return res.status(500).json({
        error: "No se pudo determinar la URL del frontend",
        detalle: "Configura FRONTEND_URL para usar Mercado Pago.",
      });
    }

    const { errors, order } = await validateOrderPayload(req.body);

    if (errors.length > 0) {
      return sendValidationError(res, errors);
    }

    const preferencePayload = {
      items: order.items.map((item) => {
        const product = order.products.find((candidate) => candidate.id === item.id);

        return {
          id: String(product.id),
          title: product.name,
          description: product.description || undefined,
          quantity: item.quantity,
          currency_id: "ARS",
          unit_price: Number(product.price),
          picture_url: product.image || undefined,
          category_id: product.category || undefined,
        };
      }),
      payer: {
        name: order.customerName,
        phone: {
          number: order.customerPhone,
        },
        address: order.address
          ? {
              street_name: order.address,
            }
          : undefined,
      },
      back_urls: {
        success: `${FRONTEND_BASE_URL}/?mp_status=success`,
        failure: `${FRONTEND_BASE_URL}/?mp_status=failure`,
        pending: `${FRONTEND_BASE_URL}/?mp_status=pending`,
      },
      auto_return: "approved",
      external_reference: `SUENA-${Date.now()}`,
      statement_descriptor: "SUENA EN GRANDE",
      notification_url: MERCADO_PAGO_WEBHOOK_URL || undefined,
      metadata: {
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        deliveryMethod: order.deliveryMethod,
        address: order.address || "",
        notes: order.notes || "",
      },
    };

    const mpResponse = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(preferencePayload),
    });

    const mpData = await mpResponse.json();

    if (!mpResponse.ok) {
      console.error("Error al crear preferencia de Mercado Pago:", mpData);
      return res.status(500).json({
        error: "No se pudo iniciar Mercado Pago",
        detalle: mpData?.message || mpData?.error || "Error al crear la preferencia de pago.",
      });
    }

    return res.status(201).json({
      ok: true,
      preferenceId: mpData.id,
      initPoint: mpData.init_point,
      sandboxInitPoint: mpData.sandbox_init_point,
    });
  } catch (error) {
    console.error("Error al preparar Checkout Pro:", error);
    return res.status(500).json({
      error: "Error al preparar el pago con Mercado Pago",
      detalle: error.message,
    });
  }
});

app.get("/admin/pedidos", async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      include: {
        items: {
          orderBy: {
            id: "asc",
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    res.json(orders);
  } catch (error) {
    console.error("Error al obtener pedidos:", error);
    res.status(500).json({
      error: "Error al obtener pedidos",
      detalle: error.message,
    });
  }
});

app.get("/admin/pedidos/:id", async (req, res) => {
  try {
    const orderId = parseInteger(req.params.id);

    if (orderId === null || orderId <= 0) {
      return sendValidationError(res, ["El id del pedido es invalido"]);
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          orderBy: {
            id: "asc",
          },
        },
      },
    });

    if (!order) {
      return res.status(404).json({
        error: "Pedido no encontrado",
      });
    }

    res.json(order);
  } catch (error) {
    console.error("Error al obtener pedido:", error);
    res.status(500).json({
      error: "Error al obtener pedido",
      detalle: error.message,
    });
  }
});

app.patch("/admin/pedidos/:id/status", async (req, res) => {
  try {
    const orderId = parseInteger(req.params.id);
    const status = sanitizeText(req.body.status);

    if (orderId === null || orderId <= 0) {
      return sendValidationError(res, ["El id del pedido es invalido"]);
    }

    if (!status || !ORDER_STATUSES.includes(status)) {
      return sendValidationError(res, [
        `El estado debe ser uno de: ${ORDER_STATUSES.join(", ")}`,
      ]);
    }

    const order = await prisma.order.update({
      where: { id: orderId },
      data: { status },
      include: {
        items: {
          orderBy: {
            id: "asc",
          },
        },
      },
    });

    res.json({
      ok: true,
      message: "Estado del pedido actualizado correctamente",
      order,
    });
  } catch (error) {
    console.error("Error al actualizar estado del pedido:", error);

    if (error.code === "P2025") {
      return res.status(404).json({
        error: "Pedido no encontrado",
      });
    }

    res.status(500).json({
      error: "Error al actualizar estado del pedido",
      detalle: error.message,
    });
  }
});

app.get("/seed", requireAdmin, async (req, res) => {
  try {
    await prisma.product.createMany({
      data: [
        {
          name: "Sahumerio de lavanda",
          price: 4500,
          stock: 10,
          category: "Sahumerios",
          description: "Aroma suave para rituales cotidianos y espacios serenos.",
        },
        {
          name: "Lampara de sal",
          price: 18500,
          stock: 4,
          category: "Decoracion",
          description: "Pieza calida para sumar luz tenue y presencia al ambiente.",
        },
        {
          name: "Perfume para ropa",
          price: 8900,
          stock: 7,
          category: "Aromatizacion",
          description: "Fragancia textil fresca para ropa de cama, cortinas y prendas.",
        },
      ],
      skipDuplicates: true,
    });

    res.json({ ok: true, message: "Productos cargados" });
  } catch (error) {
    console.error("Error al cargar productos:", error);
    res.status(500).json({ error: "Error al cargar productos" });
  }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
