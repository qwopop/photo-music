import { AuthForm } from "../auth/form";
import styles from "../auth/styles.module.css";

export default function SignupPage() {
  return <main className={styles.page}><h1>Sign up</h1><AuthForm mode="signup" /></main>;
}
