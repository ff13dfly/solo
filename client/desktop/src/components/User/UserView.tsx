import React, { useState, useEffect } from "react";
import { User, Mail, Shield, Smartphone, Lock, LogOut, ArrowRight, Loader2 } from "lucide-react";
import { useI18n } from "../../i18n/I18nProvider";
import { login, logout, isAuthenticated, callRpc } from "../../lib/rpc";

export default function UserView() {
    const { t } = useI18n();
    const [isLoggedIn, setIsLoggedIn] = useState(isAuthenticated());
    const [loading, setLoading] = useState(false);
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [profile, setProfile] = useState<any>(null);

    useEffect(() => {
        if (isLoggedIn) {
            fetchProfile();
        }
    }, [isLoggedIn]);

    const fetchProfile = async () => {
        try {
            const data = await callRpc("user.profile", {});
            setProfile(data);
        } catch (err) {
            console.error("Failed to fetch profile", err);
            // If profile fetch fails with auth error, force logout
            if (err instanceof Error && err.message.includes("UNAUTHORIZED")) {
                handleLogout();
            }
        }
    };

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!username || !password) return;

        setLoading(true);
        setError(null);
        try {
            await login(username, password);
            setIsLoggedIn(true);
        } catch (err: any) {
            setError(err.message || "Login failed. Please check your credentials.");
        } finally {
            setLoading(false);
        }
    };

    const handleLogout = () => {
        logout();
        setIsLoggedIn(false);
        setProfile(null);
    };

    if (!isLoggedIn) {
        return (
            <div className="h-full flex items-center justify-center p-8 bg-[#f5f5f7]">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="w-full max-w-md bg-white rounded-[32px] shadow-2xl shadow-black/5 p-10 border border-[#d2d2d7]/30"
                >
                    <div className="text-center mb-10">
                        <div className="w-20 h-20 bg-gradient-to-br from-[#0071e3] to-[#00c7ff] rounded-3xl mx-auto mb-6 flex items-center justify-center text-white shadow-xl shadow-blue-500/20">
                            <User size={40} />
                        </div>
                        <h2 className="text-3xl font-bold tracking-tight text-[#1d1d1f]">Sign In</h2>
                        <p className="text-[#86868b] mt-2">Access your Solo workspace</p>
                    </div>

                    <form onSubmit={handleLogin} className="space-y-6">
                        <div className="space-y-2">
                            <label className="text-sm font-semibold ml-1 text-[#1d1d1f]">Username</label>
                            <div className="relative">
                                <User className="absolute left-4 top-1/2 -translate-y-1/2 text-[#86868b]" size={18} />
                                <input
                                    type="text"
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                    placeholder="Enter your username"
                                    className="w-full pl-12 pr-4 py-4 bg-[#f5f5f7] border-none rounded-2xl focus:ring-2 focus:ring-[#0071e3] transition-all outline-none text-[#1d1d1f]"
                                    required
                                />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <label className="text-sm font-semibold ml-1 text-[#1d1d1f]">Password</label>
                            <div className="relative">
                                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-[#86868b]" size={18} />
                                <input
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    placeholder="••••••••"
                                    className="w-full pl-12 pr-4 py-4 bg-[#f5f5f7] border-none rounded-2xl focus:ring-2 focus:ring-[#0071e3] transition-all outline-none text-[#1d1d1f]"
                                    required
                                />
                            </div>
                        </div>

                        {error && (
                            <motion.p
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                className="text-red-500 text-sm font-medium text-center bg-red-50 px-4 py-2 rounded-xl"
                            >
                                {error}
                            </motion.p>
                        )}

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full bg-[#0071e3] hover:bg-[#0077ed] disabled:bg-blue-300 text-white font-bold py-4 rounded-2xl transition-all shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2 group active:scale-[0.98]"
                        >
                            {loading ? (
                                <Loader2 className="animate-spin" size={20} />
                            ) : (
                                <>
                                    Log In
                                    <ArrowRight className="group-hover:translate-x-1 transition-transform" size={20} />
                                </>
                            )}
                        </button>
                    </form>

                    <p className="mt-8 text-center text-xs text-[#86868b] leading-relaxed">
                        Secure login powered by Solo·AI Identity<br />
                        Level 3 Handshake Protocol Active
                    </p>
                </motion.div>
            </div>
        );
    }

    const userProfile = profile || {
        name: "Loading...",
        email: "-",
        role: "User",
        device: "Desktop"
    };

    return (
        <div className="max-w-4xl mx-auto h-full flex flex-col p-8 bg-white overflow-y-auto no-scrollbar">
            <header className="mb-10 flex items-center justify-between">
                <div>
                    <h2 className="text-4xl font-bold tracking-tight text-[#1d1d1f]">
                        User Profile
                    </h2>
                    <p className="text-lg text-[#86868b] mt-2">
                        Manage your identity and connected devices.
                    </p>
                </div>
                <button
                    onClick={handleLogout}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-red-50 text-red-600 hover:bg-red-100 font-semibold transition-colors active:scale-95"
                >
                    <LogOut size={18} />
                    Sign Out
                </button>
            </header>

            <div className="space-y-10">
                {/* Profile Card */}
                <section className="bg-white rounded-[40px] shadow-2xl shadow-black/[0.03] border border-[#d2d2d7]/30 overflow-hidden">
                    <div className="p-10 flex items-center gap-8 bg-gradient-to-r from-blue-50/50 to-transparent">
                        <div className="w-32 h-32 rounded-[36px] bg-gradient-to-br from-blue-500 via-blue-600 to-purple-600 flex items-center justify-center text-white text-5xl font-bold shadow-2xl shadow-blue-500/30">
                            {userProfile.name.charAt(0)}
                        </div>
                        <div>
                            <h3 className="text-4xl font-bold text-[#1d1d1f]">{userProfile.name}</h3>
                            <div className="flex items-center gap-2 mt-3">
                                <span className="px-3 py-1 rounded-full bg-blue-100 text-blue-700 text-xs font-bold uppercase tracking-wider">
                                    {userProfile.role}
                                </span>
                                <span className="w-1.5 h-1.5 rounded-full bg-[#d2d2d7]"></span>
                                <span className="text-[#86868b] text-sm font-medium">Joined {new Date(userProfile.createdAt || Date.now()).toLocaleDateString()}</span>
                            </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2">
                        <div className="p-8 border-t border-r border-[#f2f2f7] hover:bg-[#fbfbfd] transition-colors group">
                            <div className="flex items-center gap-4 mb-4">
                                <div className="p-2.5 rounded-xl bg-gray-50 text-[#86868b] group-hover:bg-blue-50 group-hover:text-blue-600 transition-colors">
                                    <Mail size={22} />
                                </div>
                                <div>
                                    <p className="text-[11px] font-bold text-[#86868b] uppercase tracking-widest">Primary Email</p>
                                    <p className="text-lg font-semibold text-[#1d1d1f] mt-0.5">{userProfile.email || 'Not provided'}</p>
                                </div>
                            </div>
                        </div>
                        <div className="p-8 border-t border-[#f2f2f7] hover:bg-[#fbfbfd] transition-colors group">
                            <div className="flex items-center gap-4 mb-4">
                                <div className="p-2.5 rounded-xl bg-gray-50 text-[#86868b] group-hover:bg-blue-50 group-hover:text-blue-600 transition-colors">
                                    <Smartphone size={22} />
                                </div>
                                <div>
                                    <p className="text-[11px] font-bold text-[#86868b] uppercase tracking-widest">Active Device</p>
                                    <p className="text-lg font-semibold text-[#1d1d1f] mt-0.5">Desktop Browser</p>
                                </div>
                            </div>
                        </div>
                        <div className="p-8 border-t border-r border-[#f2f2f7] hover:bg-[#fbfbfd] transition-colors group">
                            <div className="flex items-center gap-4 mb-4">
                                <div className="p-2.5 rounded-xl bg-gray-50 text-[#86868b] group-hover:bg-blue-50 group-hover:text-blue-600 transition-colors">
                                    <Shield size={22} />
                                </div>
                                <div>
                                    <p className="text-[11px] font-bold text-[#86868b] uppercase tracking-widest">Access Protocol</p>
                                    <p className="text-lg font-semibold text-[#1d1d1f] mt-0.5">Level 3 Full Access</p>
                                </div>
                            </div>
                        </div>
                        <div className="p-8 border-t border-[#f2f2f7] hover:bg-[#fbfbfd] transition-colors group">
                            <div className="flex items-center gap-4 mb-4">
                                <div className="p-2.5 rounded-xl bg-gray-50 text-[#86868b] group-hover:bg-blue-50 group-hover:text-blue-600 transition-colors">
                                    <Activity size={22} />
                                </div>
                                <div>
                                    <p className="text-[11px] font-bold text-[#86868b] uppercase tracking-widest">Account Status</p>
                                    <div className="flex items-center gap-2 mt-0.5">
                                        <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                                        <p className="text-lg font-semibold text-[#1d1d1f]">Verified & Active</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                <div className="bg-[#f5f5f7] rounded-3xl p-8">
                    <h4 className="font-bold text-[#1d1d1f] mb-2">Security Notice</h4>
                    <p className="text-sm text-[#86868b] leading-relaxed">
                        Your session is protected by end-to-end encryption. The desktop client uses the same security standards as our mobile and system portals. If you notice any suspicious activity, please sign out immediately and contact your system administrator.
                    </p>
                </div>
            </div>
        </div>
    );
}

// Add moton for animations if not already handled by layout
import { motion } from "framer-motion";
import { Activity } from "lucide-react";
