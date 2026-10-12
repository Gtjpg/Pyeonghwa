import { Navigate, Outlet } from "react-router-dom";
import { useSession } from "../auth";

function Loading() {
  return (
    <div className="flex h-dvh items-center justify-center bg-slate-950 text-slate-400">
      Loading...
    </div>
  );
}

/** Only logged-in users can see these pages. Others go to the login page. */
export function ProtectedRoute() {
  const status = useSession();

  if (status === "checking") return <Loading />;
  if (status === "invalid") return <Navigate to="/" replace />;

  return <Outlet />;
} 