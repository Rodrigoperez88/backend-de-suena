import "dotenv/config";
import prismaPkg from "@prisma/client";

const { PrismaClient } = prismaPkg;

const prisma = globalThis.__prisma__ || new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__prisma__ = prisma;
}

export default prisma;
