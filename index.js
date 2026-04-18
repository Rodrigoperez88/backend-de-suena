import express from "express";
import cors from "cors";
import dotenv from "dotenv";
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

const sendValidationError = (res, details) => {
  return res.status(400).json({
    error: "Datos invalidos",
    details,
  });
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
    const normalizedCustomerName = sanitizeText(req.body.customerName);
    const normalizedCustomerPhone = sanitizeText(req.body.customerPhone);
    const normalizedAddress = sanitizeText(req.body.address);
    const normalizedDeliveryMethod = sanitizeText(req.body.deliveryMethod);
    const normalizedNotes = sanitizeText(req.body.notes);
    const { errors: itemErrors, normalizedItems } = parseOrderItems(req.body.items);

    if (!normalizedCustomerName || !normalizedCustomerPhone || !normalizedDeliveryMethod) {
      return sendValidationError(res, ["Faltan datos obligatorios del cliente"]);
    }

    if (!["retiro", "envio"].includes(normalizedDeliveryMethod)) {
      return sendValidationError(res, ["El metodo de entrega es invalido"]);
    }

    if (normalizedDeliveryMethod === "envio" && !normalizedAddress) {
      return sendValidationError(res, ["La direccion es obligatoria para envios"]);
    }

    if (itemErrors.length > 0) {
      return sendValidationError(res, itemErrors);
    }

    const productIds = normalizedItems.map((item) => item.id);
    const productosDB = await prisma.product.findMany({
      where: {
        id: {
          in: productIds,
        },
      },
    });

    if (productosDB.length !== normalizedItems.length) {
      return sendValidationError(res, ["Uno o mas productos no existen"]);
    }

    for (const item of normalizedItems) {
      const productoDB = productosDB.find((product) => product.id === item.id);

      if (!productoDB) {
        return sendValidationError(res, [`Producto invalido: ${item.id}`]);
      }

      if (productoDB.stock < item.quantity) {
        return sendValidationError(res, [
          `Stock insuficiente para ${productoDB.name}`,
        ]);
      }
    }

    const total = normalizedItems.reduce((acc, item) => {
      const productoDB = productosDB.find((product) => product.id === item.id);
      return acc + productoDB.price * item.quantity;
    }, 0);

    const pedidoCreado = await prisma.$transaction(async (tx) => {
      const nuevoPedido = await tx.order.create({
        data: {
          customerName: normalizedCustomerName,
          customerPhone: normalizedCustomerPhone,
          address: normalizedAddress,
          deliveryMethod: normalizedDeliveryMethod,
          notes: normalizedNotes,
          total,
          status: "pendiente",
        },
      });

      for (const item of normalizedItems) {
        const productoDB = productosDB.find((product) => product.id === item.id);

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

app.get("/seed", async (req, res) => {
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
