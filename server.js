const express = require("express"); // for web server
const http = require("http");   // HTTP server
const cors = require("cors");   // Allows rquests from other origins
const { Server } = require("socket.io");    //Socket.IO for real - time communication
require("dotenv").config()  // Loads environment variables from .env

const supabase = require("./supabaseClient");

const app = express();
app.use(cors());
const server = http.createServer(app);

// creates SOCKET.IO server and attaches to HTTP server
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// just to ensure that the server is running
app.get("/", (req, res) => {
    res.send("Matchmaking backend running.");
});

// each connected client gets its own socket object
io.on("connection", (socket) => {
    console.log("User connection:", socket.id);

    // HANDLE MATCHMAKING LOGIC
    socket.on("start_matchmaking", async ({ userId }) => {
        try {
            socket.userId = userId; // to track which user disconnected

            console.log(`Start matchmaking requested by ${userId}`);

            // check if user already exists in the queue
            const { data: existingUser, error: existingError } = await supabase
                .from("waiting_queue")
                .select("*")
                .eq("user_id", userId);
            
            if (existingError) {
                console.error("Existing user query error:", existingError);
                socket.emit("info", { message: "Error checking queue." });
                return;
            }
            
            // stops duplicate queue entries
            if (existingUser.length > 0) {
                socket.emit("info", { message: "You are already in the queue."});
                return;
            }

            // add user to the queue
            const { error: insertQueueError } = await supabase
                .from("waiting_queue")
                .insert([
                    {
                        user_id: userId,
                        socket_id: socket.id
                    }
                ]);
            
            if (insertQueueError) {
                console.error("Queue insert error:", insertQueueError);
                socket.emit("info", { message: "Error joining queue." });
                return;
            }
            
            // look for the next available waiting user (oldest first)
            const { data: waitingUsers, error: waitingError } = await supabase
                .from("waiting_queue")
                .select("*")
                .neq("user_id", userId)
                .order("created_at", { ascending: true })
                .limit(1);
            
            if (waitingError) {
                console.error("Waiting users query error:", waitingError);
                socket.emit("info", { message: "Error finding partner." });
                return;
            }
            
            // implemented if partner exists
            if (waitingUsers.length > 0) {

                const partner = waitingUsers[0];

                // remove both users from the waiting_queue
                await supabase.from("waiting_queue").delete().eq("user_id", userId);
                await supabase.from("waiting_queue").delete().eq("user_id", partner.user_id);

                // performs the actual matchmaking between the users
                const { data: matchData, error: matchError } = await supabase
                    .from("matches")
                    .insert([
                        {
                            user1_id: userId,
                            user2_id: partner.user_id,
                            status: "active"
                        }
                    ])
                    .select();
                
                if (matchError) {
                    console.error("Match insert error:", matchError);
                    socket.emit("info", { message: "Error creating match." });
                    return;
                }

                if (!matchData || matchData.length === 0) {
                    console.error("No match data returned from Supabase.");
                    socket.emit("info", { message: "Match creation failed." });
                    return;
                }
                
                // send the matched partner to both the users
                socket.emit("match_found", {
                    matchId: matchData[0].id,
                    partnerId: partner.user_id
                });

                io.to(partner.socket_id).emit("match_found", {
                    matchId: matchData[0].id,
                    partnerId: userId
                });

                console.log(`Matched ${userId} with ${partner.user_id}`);
            } else {

                socket.emit("queued", { message: "Waiting for a partner..."});  // executes if no partner exists to be matched in the queue

            }

        } catch(error) {

            console.error(error);
            socket.emit("info", { message: "Server error." });

        }
    });
    
    // HANDLE NEXT PARTNER TO BE MATCHED LOGIC
    socket.on("next_partner", async ({ userId }) => {
        try {
            
            // find the current active match
            const { data: activeMatches, error: activeMatchesError } = await supabase
                .from("matches")
                .select("*")
                .eq("status", "active")
                .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);
            
            if (activeMatchesError) {
                console.error("Active matches query error:", activeMatchesError);
                socket.emit("info", { message: "Error finding current match." });
                return;
            }
            
            // if found, change the match status to ended
            if (activeMatches.length > 0) {
                
                await supabase
                    .from("matches")
                    .update({ status: "ended" })
                    .eq("id", activeMatches[0].id);
            }

            // remove the user from the waiting_queue just to be sure
            await supabase
                .from("waiting_queue")
                .delete()
                .eq("user_id", userId);
            
            // add the user back to the waiting queue
            const { error: requeueInsertError } = await supabase
                .from("waiting_queue")
                .insert([
                    {
                        user_id: userId,
                        socket_id: socket.id
                    }
                ]);
            
            if (requeueInsertError) {
                console.error("Requeue insert error:", requeueInsertError);
                socket.emit("info", { message: "Error re-entering queue." });
                return;
            }
            
            // emit queued back to the client
            socket.emit("queued", { message: "Re-entered queue"});

        } catch(error) {

            console.error(error);
            socket.emit("info", { message: "Server error." });
        }
    });

    // HANDLE DISCONNECT WHEN CLIENT CONNECTION CLOSES
    socket.on("disconnect", async () => {

        try {

            console.log("Disconnected:", socket.id);
            
            // gets the userID from socket.userId
            const userId = socket.userId;

            if (!userId) return;

            // remove them from the waiting_queue just to be sure
            await supabase
                .from("waiting_queue")
                .delete()
                .eq("user_id", userId);
            
            // check to see if the user who disconnected had an active match
            const { data: activeMatches } = await supabase
                .from("matches")
                .select("*")
                .eq("status", "active")
                .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);
            
            // if there was an active match, then update the match status to ended
            if (activeMatches.length > 0) {

                const match = activeMatches[0];

                await supabase
                    .from("matches")
                    .update({ status: "ended" })
                    .eq("id", match.id);
                
                console.log(`Ended match because ${userId} disconnected`);

            }
        } catch (error) {

            console.error(error);

        }
    });
});

const PORT = process.env.PORT || 3000;

// starts backend on the chosen port
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
