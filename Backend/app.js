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
const router = express.Router();
app.use(cors());
app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(router);

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

// User schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  status: { type: String, default: "offline" },
  mobileNumber: { type: String, default: "" },
  profileImage: { type: String, default: "" },
});

const User = mongoose.model("User", userSchema);

// Message schema
const messageSchema = new mongoose.Schema({
  sender: { type: String, required: true },
  receiver: { type: String },
  content: String,
  timestamp: { type: Date, default: Date.now },
  isDelivered: { type: Boolean, default: false },
  isRead: { type: Boolean, default: false },
});

const Message = mongoose.model("Message", messageSchema);

// Middleware for authentication
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Token not provided" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ message: "Invalid or expired token" });
  }
};

// WebSocket handling
const onlineUsers = new Map();

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("setUsername", async (username) => {
    onlineUsers.set(socket.id, username);
    await User.findOneAndUpdate({ username }, { status: "online" });
    io.emit("onlineUsers", Array.from(onlineUsers.values()));
    console.log(`Socket ${socket.id} set as ${username}`);
  });

  socket.on("disconnect", async () => {
    const username = onlineUsers.get(socket.id);
    if (username) {
      await User.findOneAndUpdate({ username }, { status: "offline" });
      onlineUsers.delete(socket.id);
      io.emit("onlineUsers", Array.from(onlineUsers.values()));
    }
    console.log("User disconnected:", socket.id);
  });
});

// Messages route
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

// File upload setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname)); // Generate unique filenames
  },
});

const upload = multer({ storage });

// Upload a file
app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "File upload failed" });
  }

  const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
  res.json({ url: fileUrl, type: req.file.mimetype.split("/")[0] });
});

// Fetch all online users
router.get("/online-users", (req, res) => {
  res.json(Array.from(onlineUsers.values()));
});

// Update profile route
router.put("/update-profile", authenticate, upload.single("profileImage"), async (req, res) => {
  const { username, status, mobileNumber } = req.body;
  const userId = req.user?.id;

  try {
    const updateData = {
      ...(username && { username }),
      ...(status && { status }),
      ...(mobileNumber && { mobileNumber }),
      ...(req.file && { profileImage: req.file.path }),
    };

    const updatedUser = await User.findByIdAndUpdate(userId, updateData, {
      new: true,
      runValidators: true,
    }).select("-password");

    if (!updatedUser) return res.status(404).json({ message: "User not found" });

    res.status(200).json({ message: "Profile updated successfully", user: updatedUser });
  } catch (error) {
    res.status(500).json({ message: "Failed to update profile", error: error.message });
  }
});

// Signup route
router.post("/signup", async (req, res) => {
  const { username, password } = req.body;

  try {
    const existingUser = await User.findOne({ username });
    if (existingUser) return res.status(400).json({ message: "Username already taken." });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ username, password: hashedPassword });
    await newUser.save();

    res.status(201).json({ message: "Signup successful!" });
  } catch (error) {
    res.status(500).json({ message: "Signup failed", error: error.message });
  }
});

// Login route
router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ message: "User not found." });

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) return res.status(401).json({ message: "Invalid credentials." });

    const token = jwt.sign({ id: user._id, username: user.username }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    res.status(200).json({ message: "Login successful!", token });
  } catch (error) {
    res.status(500).json({ message: "Login failed", error: error.message });
  }
});

// Fetch all users
router.get("/users", async (req, res) => {
  try {
    const users = await User.find();
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch users", error: error.message });
  }
});

// Catch-all for undefined routes
app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: "Internal server error", error: err.message });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
