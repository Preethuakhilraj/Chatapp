const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// WebSocket setup
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

// MongoDB connection
mongoose
  .connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("Error connecting to MongoDB:", err));

// Message schema
const messageSchema = new mongoose.Schema({
  sender: { type: String, required: true },
  receiver: { type: String }, // Optional, for private messages
  content: String,
  timestamp: { type: Date, default: Date.now },
  isDelivered: { type: Boolean, default: false },
  isRead: { type: Boolean, default: false },
});
const Message = mongoose.model("Message", messageSchema);

// User schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
});
const User = mongoose.model("User", userSchema);

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// WebSocket handling
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("setUsername", (username) => {
    socket.username = username;
    console.log(`Socket ${socket.id} set as ${username}`);
  });

  socket.on("sendMessage", async (message) => {
    try {
      if (!message.sender || !message.content) {
        throw new Error("Invalid message payload");
      }

      const savedMessage = await Message.create({
        sender: message.sender,
        receiver: message.receiver || null,
        content: message.content,
        timestamp: new Date(),
        isDelivered: true,
      });

      const formattedMessage = {
        _id: savedMessage._id.toString(),
        sender: savedMessage.sender,
        receiver: savedMessage.receiver,
        content: savedMessage.content,
        timestamp: savedMessage.timestamp,
        isDelivered: savedMessage.isDelivered,
        isRead: savedMessage.isRead,
      };

      if (message.receiver) {
        const receiverSocket = Array.from(io.sockets.sockets.values()).find(
          (s) => s.username === message.receiver
        );
        if (receiverSocket) {
          receiverSocket.emit("receiveMessage", formattedMessage);
        }
      } else {
        io.emit("receiveMessage", formattedMessage);
      }
    } catch (err) {
      console.error("Error saving message:", err);
    }
  });

  socket.on("markAsRead", async (messageId) => {
    try {
      const message = await Message.findById(messageId);
      if (message) {
        message.isRead = true;
        await message.save();
        io.emit("updateMessageStatus", {
          _id: message._id,
          isRead: message.isRead,
        });
      }
    } catch (err) {
      console.error("Error marking message as read:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// API Routes
app.get("/messages", async (req, res) => {
  try {
    const { sender, receiver } = req.query;
    const filter = {};
    if (sender) filter.sender = sender;
    if (receiver) filter.receiver = receiver;

    const messages = await Message.find(filter).sort({ timestamp: -1 });
    res.json(messages);
  } catch (err) {
    console.error("Error fetching messages:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

app.post("/messages", async (req, res) => {
  try {
    const { sender, receiver, content } = req.body;
    const newMessage = new Message({
      sender,
      receiver,
      content,
      isDelivered: true,
      isRead: false,
    });

    await newMessage.save();
    res.status(201).json(newMessage);
  } catch (error) {
    console.error("Error saving message:", error);
    res.status(500).json({ error: "Failed to save message" });
  }
});

// Upload a file
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "File upload failed" });
  }

  const fileType = req.file.mimetype.split("/")[0];
  const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

  res.json({ url: fileUrl, type: fileType });
});

// Signup route
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;

  try {
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ message: "Username already taken." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ username, password: hashedPassword });
    await newUser.save();

    res.status(201).json({ message: "Signup successful!" });
  } catch (error) {
    console.error("Error during signup:", error);
    res.status(500).json({ message: "An error occurred. Please try again." });
  }
});

// Login route
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid credentials." });
    }

    const token = jwt.sign({ id: user._id, username: user.username }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    res.status(200).json({
      message: "Login successful!",
      username: user.username,
      token,
    });
  } catch (error) {
    console.error("Error during login:", error);
    res.status(500).json({ message: "An error occurred. Please try again." });
  }
});

// Fetch all users
app.get("/users", async (req, res) => {
  try {
    const users = await User.find();
    res.status(200).json(users);
  } catch (err) {
    res.status(500).json({ message: "Error fetching users", error: err.message });
  }
});

// Start the server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
